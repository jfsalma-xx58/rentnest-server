import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const db = client.db("rentnestDB");
const propertiesCollection = db.collection("properties");
const usersCollection = db.collection("users");

async function run() {
  try {
    await client.connect();
    await db.command({ ping: 1 });
    console.log("MongoDB connected to rentnestDB");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
  }
}
run();

// ---------- Middleware ----------

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};

const verifyRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).send({ message: "forbidden access" });
      }
      req.userRole = user.role;
      next();
    } catch (error) {
      res.status(500).send({ message: "Server error" });
    }
  };
};

// Ready to use on routes later:
// const verifyAdmin = verifyRole("admin");
// const verifyOwner = verifyRole("owner");

// ---------- Auth routes ----------

app.get("/", (req, res) => {
  res.send("RentNest server is running");
});

app.post("/jwt", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).send({ message: "Email is required" });
  }
  const user = await usersCollection.findOne({ email });
  if (!user) {
    return res.status(404).send({ message: "User not found" });
  }
  const token = jwt.sign({ email }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
  res.send({ token });
});

// ---------- User routes ----------

app.post("/users", async (req, res) => {
  try {
    const { name, email, photo } = req.body;
    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }
    const existing = await usersCollection.findOne({ email });
    if (existing) {
      return res.send({ message: "User already exists", inserted: false });
    }
    const newUser = {
      name: name || "",
      email,
      photo: photo || "",
      role: "tenant",
      createdAt: new Date(),
    };
    const result = await usersCollection.insertOne(newUser);
    res.send({ inserted: true, insertedId: result.insertedId });
  } catch (error) {
    res.status(500).send({ message: "Failed to save user" });
  }
});

app.get("/users/role/:email", verifyToken, async (req, res) => {
  if (req.params.email !== req.decoded.email) {
    return res.status(403).send({ message: "forbidden access" });
  }
  const user = await usersCollection.findOne({ email: req.params.email });
  res.send({ role: user?.role || "tenant" });
});

// ---------- Property routes ----------

// Keep this above "/properties/:id" so "featured" isn't read as an id
app.get("/properties/featured", async (req, res) => {
  try {
    const result = await propertiesCollection
      .find({ status: "approved" })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load featured properties" });
  }
});

app.get("/properties/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).send({ message: "Property not found" });
    }
    const property = await propertiesCollection.findOne({
      _id: new ObjectId(id),
    });
    if (!property) {
      return res.status(404).send({ message: "Property not found" });
    }
    res.send(property);
  } catch (error) {
    res.status(500).send({ message: "Failed to load property" });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});