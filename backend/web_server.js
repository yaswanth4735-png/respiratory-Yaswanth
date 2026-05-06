require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

// ----------------------------
// PYTHON ML API URL
// ----------------------------
function normalizePythonBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

if (!process.env.PYTHON_API_URL) {
  throw new Error(
    "PYTHON_API_URL environment variable is required"
  );
}

const PYTHON_API_URL = normalizePythonBaseUrl(
  process.env.PYTHON_API_URL
);

console.log("Using ML API:", PYTHON_API_URL);

// ----------------------------
// TIMEOUTS
// ----------------------------
const PYTHON_API_TIMEOUT_MS = parseInt(
  process.env.PYTHON_API_TIMEOUT_MS || "120000",
  10
);

const PYTHON_API_MAX_RETRIES = parseInt(
  process.env.PYTHON_API_MAX_RETRIES || "3",
  10
);

// ----------------------------
// MONGODB
// ----------------------------
const MONGO_URI =
  process.env.DATABASE_URL ||
  process.env.MONGO_URI;

if (!MONGO_URI) {
  throw new Error("MongoDB URI missing");
}

// ----------------------------
// JWT
// ----------------------------
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}

const JWT_EXPIRES_IN =
  process.env.JWT_EXPIRES_IN || "7d";

// ----------------------------
// EXPRESS
// ----------------------------
app.use(cors());

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "..", "frontend")
  )
);

// ----------------------------
// DATABASE
// ----------------------------
let db;
let usersCol;
let predictionsCol;

async function connectDB() {
  try {

    const client = new MongoClient(MONGO_URI);

    await client.connect();

    db = client.db("crop_recommendation_db");

    usersCol = db.collection("users");

    predictionsCol = db.collection("predictions");

    await usersCol.createIndex(
      { email: 1 },
      { unique: true }
    );

    console.log("✅ MongoDB connected");

  } catch (error) {

    console.error(
      "MongoDB connection failed:",
      error.message
    );
  }
}

connectDB();

// ----------------------------
// HELPERS
// ----------------------------
function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

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

  if (Array.isArray(d)) {

    return d
      .map((x) =>
        x?.msg ? x.msg : String(x)
      )
      .join("; ");
  }

  return null;
}

async function callPythonAxios(requestFn) {

  let lastError;

  for (
    let attempt = 1;
    attempt <= PYTHON_API_MAX_RETRIES;
    attempt++
  ) {

    try {

      return await requestFn();

    } catch (error) {

      lastError = error;

      if (
        !isRetryableMlProxyError(error) ||
        attempt === PYTHON_API_MAX_RETRIES
      ) {
        throw error;
      }

      const delay = Math.min(
        2000 * attempt,
        15000
      );

      console.warn(
        `Retry ${attempt} in ${delay}ms`
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
    {
      expiresIn: JWT_EXPIRES_IN,
    }
  );
}

function authenticateToken(
  req,
  res,
  next
) {

  const authHeader =
    req.headers.authorization || "";

  const [scheme, token] =
    authHeader.split(" ");

  if (
    scheme !== "Bearer" ||
    !token
  ) {
    return res.status(401).json({
      detail: "Missing token",
    });
  }

  try {

    req.user = jwt.verify(
      token,
      JWT_SECRET
    );

    next();

  } catch {

    return res.status(401).json({
      detail: "Invalid token",
    });
  }
}

// ----------------------------
// HEALTH
// ----------------------------
app.get("/health", (req, res) => {

  res.status(200).json({
    status: "ok",
    backend: "running",
    ml_api: PYTHON_API_URL,
  });
});

// ----------------------------
// SIGNUP
// ----------------------------
app.post("/signup", async (req, res) => {

  if (!db) {
    return res.status(503).json({
      detail: "Database unavailable",
    });
  }

  const {
    email,
    password,
    firstName,
    lastName,
  } = req.body;

  if (
    !email ||
    !password ||
    !firstName ||
    !lastName
  ) {
    return res.status(400).json({
      detail: "Missing fields",
    });
  }

  const existingUser =
    await usersCol.findOne({ email });

  if (existingUser) {

    return res.status(400).json({
      detail: "Email already exists",
    });
  }

  const hashedPassword =
    await bcrypt.hash(password, 10);

  await usersCol.insertOne({
    email,
    password: hashedPassword,
    first_name: firstName,
    last_name: lastName,
    created_at: new Date(),
  });

  res.json({
    message: "Signup successful",
  });
});

// ----------------------------
// LOGIN
// ----------------------------
app.post("/login", async (req, res) => {

  const { email, password } = req.body;

  const user =
    await usersCol.findOne({ email });

  if (!user) {

    return res.status(401).json({
      detail: "Invalid credentials",
    });
  }

  const isMatch =
    await bcrypt.compare(
      password,
      user.password
    );

  if (!isMatch) {

    return res.status(401).json({
      detail: "Invalid credentials",
    });
  }

  const token =
    createAuthToken(user);

  res.json({
    token,
    user: {
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
    },
  });
});

// ----------------------------
// PREDICT
// ----------------------------
app.post(
  "/predict",
  authenticateToken,
  async (req, res) => {

    try {

      console.log(
        "Sending request to ML API..."
      );

      const pythonRes =
        await callPythonAxios(() =>
          axios.post(
            `${PYTHON_API_URL}/predict`,
            req.body,
            {
              timeout:
                PYTHON_API_TIMEOUT_MS,
            }
          )
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

      console.error(
        "ML API ERROR:",
        error.message
      );

      console.error(
        error.response?.data
      );

      const forwarded =
        mlHttpDetail(error);

      res.status(503).json({
        detail:
          forwarded ||
          "ML service unavailable (cold start or wrong URL)",
      });
    }
  }
);

// ----------------------------
// START SERVER
// ----------------------------
app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );
});

