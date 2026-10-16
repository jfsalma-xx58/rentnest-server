// Chooses which property the homepage highlights.
//   node set-featured.js                       (Riverside Luxury Villa)
//   node set-featured.js "Another Title"       (any property, by exact title)
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const title = process.argv[2] || "Riverside Luxury Villa";
const client = new MongoClient(process.env.MONGODB_URI);

async function run() {
  try {
    await client.connect();
    const properties = client.db("rentnestDB").collection("properties");

    const target = await properties.findOne({ title, status: "approved" });

    if (!target) {
      console.log(`No approved property titled "${title}" was found.`);
      return;
    }

    await properties.updateMany(
      { featured: true },
      { $unset: { featured: "" } }
    );
    await properties.updateOne({ _id: target._id }, { $set: { featured: true } });

    console.log(`"${title}" is now the featured property.`);
  } catch (error) {
    console.error("Failed:", error.message);
  } finally {
    await client.close();
  }
}

run();