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
const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8001";

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
    const pythonRes = await axios.get(`${PYTHON_API_URL}/season-recs`, {
      params: { season },
    });
    res.json(pythonRes.data);
  } catch (error) {
    res.status(503).json({ detail: "ML service unavailable" });
  }
});


// Predict
app.post("/predict", authenticateToken, async (req, res) => {
  try {
    const pythonRes = await axios.post(`${PYTHON_API_URL}/predict`, req.body);
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
    res.status(503).json({ detail: "ML service unavailable" });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

