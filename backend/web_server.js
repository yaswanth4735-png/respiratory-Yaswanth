require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000; // ensure correct port for Render

/** Base URL for the FastAPI ML service (no trailing slash). */
function normalizePythonBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

const PYTHON_API_URL = normalizePythonBaseUrl(
  process.env.PYTHON_API_URL || "http://127.0.0.1:8001",
);

/** Render free-tier cold starts can exceed 60s; keep configurable. */
const PYTHON_API_TIMEOUT_MS = parseInt(
  process.env.PYTHON_API_TIMEOUT_MS || "120000",
  10,
);
const PYTHON_API_MAX_RETRIES = parseInt(
  process.env.PYTHON_API_MAX_RETRIES || "3",
  10,
);

if (
  process.env.RENDER &&
  (PYTHON_API_URL.includes("127.0.0.1") || PYTHON_API_URL.includes("localhost"))
) {
  console.error(
    "⚠️ PYTHON_API_URL points at localhost while running on Render. " +
      "Set PYTHON_API_URL to your crop-ml-api service URL (Blueprint wires this via RENDER_EXTERNAL_URL).",
  );
}

const MONGO_URI =
  process.env.DATABASE_URL ||
  process.env.MONGO_URI ||
  "mongodb://localhost:27017";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required.");
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

let db, usersCol, predictionsCol;

async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("crop_recommendation_db");
    usersCol = db.collection("users");
    predictionsCol = db.collection("predictions");

    await usersCol.createIndex({ email: 1 }, { unique: true });

    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("⚠️ MongoDB connection failed:", error.message);
  }
}

connectDB();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for cold-start / proxy issues; not for application-level 503 from FastAPI. */
function isRetryableMlProxyError(error) {
  if (!error.response) {
    const c = error.code;
    return (
      c === "ECONNRESET" ||
      c === "ETIMEDOUT" ||
      c === "ECONNABORTED" ||
      c === "ECONNREFUSED" ||
      c === "ENOTFOUND" ||
      c === "EAI_AGAIN"
    );
  }
  const s = error.response.status;
  return s === 502 || s === 504;
}

function mlHttpDetail(error) {
  const d = error.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d))
    return d
      .map((x) => (x && typeof x.msg === "string" ? x.msg : String(x)))
      .join("; ");
  return null;
}

async function callPythonAxios(requestFn) {
  let lastError;
  for (let attempt = 1; attempt <= PYTHON_API_MAX_RETRIES; attempt += 1) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      if (!isRetryableMlProxyError(error) || attempt === PYTHON_API_MAX_RETRIES) {
        throw error;
      }
      const delay = Math.min(2000 * attempt, 15000);
      console.warn(
        `ML service request attempt ${attempt}/${PYTHON_API_MAX_RETRIES} failed (${error.code || error.response?.status}); retry in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

function createAuthToken(user) {
  return jwt.sign(
    {
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ detail: "Missing or invalid token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ detail: "Invalid or expired token" });
  }
}

//
// 🔥 FIXED HEALTH CHECK (VERY IMPORTANT)
//
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});


// Signup
app.post("/signup", async (req, res) => {
  if (!db) return res.status(503).json({ detail: "Database unavailable" });

  const { email, password, firstName, lastName } = req.body;

  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({ detail: "Missing fields" });
  }

  const existingUser = await usersCol.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ detail: "Email already registered" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await usersCol.insertOne({
    email,
    first_name: firstName,
    last_name: lastName,
    password: hashedPassword,
    created_at: new Date(),
  });

  res.json({ message: "User created successfully" });
});


// Login
app.post("/login", async (req, res) => {
  if (!db) return res.status(503).json({ detail: "Database unavailable" });

  const { email, password } = req.body;

  const user = await usersCol.findOne({ email });
  if (!user) {
    return res.status(401).json({ detail: "Invalid email or password" });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(401).json({ detail: "Invalid email or password" });
  }

  const token = createAuthToken(user);

  res.json({
    message: "Login successful",
    token,
    user: {
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
    },
  });
});


app.get("/me", authenticateToken, (req, res) => {
  res.json({
    user: {
      email: req.user.email,
      first_name: req.user.first_name,
      last_name: req.user.last_name,
    },
  });
});


// Season recommendations
app.get("/season-recs", async (req, res) => {
  const season = String(req.query.season || "").trim();

  if (!season) {
    return res.status(400).json({ detail: "Season required" });
  }

  try {
    const pythonRes = await callPythonAxios(() =>
      axios.get(`${PYTHON_API_URL}/season-recs`, {
        params: { season },
        timeout: PYTHON_API_TIMEOUT_MS,
      }),
    );
    res.json(pythonRes.data);
  } catch (error) {
    const forwarded = mlHttpDetail(error);
    console.error("season-recs ML error:", error.message, error.response?.status);
    res.status(503).json({
      detail:
        forwarded ||
        "ML service unavailable (check PYTHON_API_URL or cold start — try again).",
    });
  }
});


// Predict
app.post("/predict", authenticateToken, async (req, res) => {
  try {
    const pythonRes = await callPythonAxios(() =>
      axios.post(`${PYTHON_API_URL}/predict`, req.body, {
        timeout: PYTHON_API_TIMEOUT_MS,
      }),
    );
    const data = pythonRes.data;

    if (db) {
      await predictionsCol.insertOne({
        timestamp: new Date(),
        features: req.body,
        ...data,
      });
    }

    res.json(data);
  } catch (error) {
    const forwarded = mlHttpDetail(error);
    console.error("predict ML error:", error.message, error.response?.status);
    res.status(503).json({
      detail:
        forwarded ||
        "ML service unavailable (check PYTHON_API_URL or cold start — try again).",
    });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

