// One-time fix for payments and bookings saved BEFORE the BDT change.
// Those records hold the Stripe USD amount in "amount". New records hold the
// BDT fee in "amount" and the USD charge in "chargedAmount".
//
// Safe by default: it only PRINTS what it would change.
//   node migrate-amounts.js          (preview)
//   node migrate-amounts.js --apply  (writes the changes)
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const APPLY = process.argv.includes("--apply");
const RATE = Number(process.env.BDT_PER_USD) || 123.75;

const client = new MongoClient(process.env.MONGODB_URI);

async function migrate(collection, label) {
  // Old records are the ones without a saved Stripe charge.
  const old = await collection
    .find({ chargedAmount: { $exists: false }, amount: { $type: "number" } })
    .toArray();

  console.log(`${label}: ${old.length} old record(s) found.`);

  for (const doc of old) {
    const usd = doc.amount;
    const bdt = Math.round(usd * RATE * 100) / 100;

    console.log(
      `  ${doc.transactionId || doc._id}: $${usd} -> ৳${bdt}`
    );

    if (APPLY) {
      await collection.updateOne(
        { _id: doc._id, chargedAmount: { $exists: false } },
        { $set: { amount: bdt, chargedAmount: usd, chargedCurrency: "usd" } }
      );
    }
  }
}

async function run() {
  try {
    await client.connect();
    const db = client.db("rentnestDB");

    await migrate(db.collection("payments"), "payments");
    await migrate(db.collection("bookings"), "bookings");

    console.log(
      APPLY
        ? "Done. Changes were written."
        : "Preview only. Run again with --apply to write the changes."
    );
  } catch (error) {
    console.error("Migration failed:", error.message);
  } finally {
    await client.close();
  }
}

run();