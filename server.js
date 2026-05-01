require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const PYTHON_API_URL = "http://127.0.0.1:8001";
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required. Set it in your .env file.");
}

app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "frontend")));

let db, usersCol, predictionsCol;

async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("crop_recommendation_db");
    usersCol = db.collection("users");
    predictionsCol = db.collection("predictions");
    
    // Create unique index for user emails
    await usersCol.createIndex({ email: 1 }, { unique: true });
    console.log("Connected to MongoDB successfully!");
  } catch (error) {
    console.error("Warning: Could not connect to MongoDB:", error);
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
    return res.status(401).json({ detail: "Missing or invalid authorization token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ detail: "Invalid or expired token" });
  }
}

// Signup Route
app.post("/signup", async (req, res) => {
  if (!db) return res.status(503).json({ detail: "Database connection is currently down." });

  const { email, password, firstName, lastName } = req.body;
  
  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({ detail: "Missing required fields" });
  }

  const existingUser = await usersCol.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ detail: "Email already registered" });
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const newUser = {
    email,
    first_name: firstName,
    last_name: lastName,
    password: hashedPassword,
    created_at: new Date()
  };

  await usersCol.insertOne(newUser);
  res.json({ message: "User created successfully" });
});

// Login Route
app.post("/login", async (req, res) => {
  if (!db) return res.status(503).json({ detail: "Database connection is currently down." });

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
      last_name: user.last_name
    }
  });
});

app.get("/me", authenticateToken, async (req, res) => {
  res.json({
    user: {
      email: req.user.email,
      first_name: req.user.first_name,
      last_name: req.user.last_name,
    },
  });
});

// Predict Route
app.post("/predict", authenticateToken, async (req, res) => {
  try {
    // 1. Forward request to Python ML Microservice
    const pythonRes = await axios.post(`${PYTHON_API_URL}/predict`, req.body);
    const predictionData = pythonRes.data;

    // 2. Save prediction history to MongoDB (if available)
    if (db) {
      try {
        const doc = {
          timestamp: new Date(),
          features: req.body,
          recommended_crop: predictionData.recommended_crop,
          confidence: predictionData.confidence,
          financials: {
            investment: predictionData.estimated_investment,
            profit: predictionData.estimated_profit,
            insight: predictionData.market_insight
          }
        };
        await predictionsCol.insertOne(doc);
      } catch (dbErr) {
        console.error("Failed to save prediction to MongoDB:", dbErr);
      }
    }

    // 3. Respond to frontend
    res.json(predictionData);

  } catch (error) {
    console.error("Error calling Python ML service:", error.message);
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(503).json({ detail: "Machine Learning service is unavailable." });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Node.js API Gateway running on port ${PORT}`);
});
