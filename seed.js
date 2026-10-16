import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const client = new MongoClient(process.env.MONGODB_URI);

const img = (text) =>
  `https://placehold.co/600x400/0F5257/F7F3EA?text=${encodeURIComponent(text)}`;

// SAMPLE DATA for testing only. Replace with real listings before launch.
// Rents are stored in USD (the site shows them in BDT at 1 USD = 123.75).
const base = {
  rentType: "Monthly",
  status: "approved",
  ownerName: "Sample Owner",
  ownerEmail: "owner@example.com",
  createdAt: new Date(),
};

const properties = [
  { ...base, title: "Lakeview 2-Bed Apartment", location: "Dhaka", type: "Apartment", rent: 450, bedrooms: 2, bathrooms: 2, size: 1100, amenities: ["WiFi", "Parking", "Lift"], images: [img("Lakeview Apartment")], description: "Bright apartment with a calm lake view, close to shops and transport.", extraFeatures: "Balcony" },
  { ...base, title: "Green Garden Family House", location: "Chattogram", type: "House", rent: 800, bedrooms: 4, bathrooms: 3, size: 2200, amenities: ["Garden", "Parking", "Security"], images: [img("Garden House")], description: "Spacious family house with a private garden in a quiet neighbourhood.", extraFeatures: "Rooftop terrace" },
  { ...base, title: "Modern City Studio", location: "Dhaka", type: "Studio", rent: 250, bedrooms: 1, bathrooms: 1, size: 520, amenities: ["WiFi", "AC", "Lift"], images: [img("City Studio")], description: "Compact, fully furnished studio ideal for students and young professionals.", extraFeatures: "Furnished" },
  { ...base, title: "Riverside Luxury Villa", location: "Sylhet", type: "Villa", rent: 1500, bedrooms: 5, bathrooms: 4, size: 3800, amenities: ["Pool", "Garden", "Parking", "Security"], images: [img("Riverside Villa")], description: "Premium villa with river views, a private pool and generous living spaces.", extraFeatures: "Private pool" },
  { ...base, title: "Cozy Room Near University", location: "Comilla", type: "Room", rent: 120, bedrooms: 1, bathrooms: 1, size: 300, amenities: ["WiFi", "Study desk"], images: [img("University Room")], description: "Quiet single room a short walk from the university campus.", extraFeatures: "Utilities included" },
  { ...base, title: "Sunny 3-Bed Family Flat", location: "Chattogram", type: "Apartment", rent: 600, bedrooms: 3, bathrooms: 2, size: 1500, amenities: ["Parking", "Lift", "Generator"], images: [img("Family Flat")], description: "Airy flat on a high floor with plenty of natural light.", extraFeatures: "Generator backup" },
  { ...base, title: "Seaside 2-Bed Apartment", location: "Cox's Bazar", type: "Apartment", rent: 350, bedrooms: 2, bathrooms: 2, size: 950, amenities: ["WiFi", "AC", "Sea view"], images: [img("Seaside Apartment")], description: "Light apartment a short walk from the beach, with a sea-facing balcony.", extraFeatures: "Balcony" },
];

async function seed() {
  try {
    await client.connect();
    const collection = client.db("rentnestDB").collection("properties");

    // Adds only the sample listings that are missing (matched by title).
    // Existing listings are never changed or duplicated.
    let added = 0;

    for (const property of properties) {
      const result = await collection.updateOne(
        { title: property.title },
        { $setOnInsert: property },
        { upsert: true }
      );

      if (result.upsertedCount > 0) added += 1;
    }

    console.log(
      added > 0
        ? `Added ${added} sample properties.`
        : "All sample properties already exist. Nothing added."
    );
  } catch (error) {
    console.error("Seeding failed:", error.message);
  } finally {
    await client.close();
  }
}

seed();