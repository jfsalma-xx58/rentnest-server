import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

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

app.get("/", (req, res) => {
  res.send("RentNest server is running");
});

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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});