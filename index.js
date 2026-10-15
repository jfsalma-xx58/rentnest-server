import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import {
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

dotenv.config();

// ---------- Firebase Admin (verifies sign-in tokens) ----------

// Public value (it is also in the website code). .env overrides it.
const FIREBASE_PROJECT_ID =
  (process.env.FIREBASE_PROJECT_ID || "rentnest-61eab").trim().replace(/^["']|["']$/g, "");
console.log("Firebase project ID in use:", FIREBASE_PROJECT_ID);

// Checking a sign-in token only needs your Firebase project ID, so the
// simplest setup is FIREBASE_PROJECT_ID in .env. A full service account
// (FIREBASE_SERVICE_ACCOUNT_JSON) also works.
const firebaseApp =
  getApps()[0] ||
  initializeApp(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? { credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) }
      : { projectId: FIREBASE_PROJECT_ID }
  );


const firebaseAuth = getAuth(firebaseApp);

// Turn this on once your Register page sends a verification email.
const REQUIRE_VERIFIED_EMAIL = process.env.REQUIRE_VERIFIED_EMAIL === "true";

const app = express();
const port = process.env.PORT || 5000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// The reservation fee is 10% of the rent.
const RESERVATION_RATE = 0.1;

// Property rent values in MongoDB are stored in USD.
// The site shows money in BDT (1 USD = BDT_PER_USD) and Stripe charges USD.
const PAYMENT_CURRENCY = (process.env.PAYMENT_CURRENCY || "usd").toLowerCase();
const BDT_PER_USD = Number(process.env.BDT_PER_USD) || 0;

// A bad payment setting must not take the whole site down: browsing still
// works, and only payment routes refuse until .env is fixed.
let paymentConfigError = "";

if (PAYMENT_CURRENCY !== "usd") {
  paymentConfigError = 'PAYMENT_CURRENCY must be "usd"';
} else if (!(BDT_PER_USD > 0)) {
  paymentConfigError = "Set a valid BDT_PER_USD value in .env";
}

if (paymentConfigError) {
  console.error("PAYMENT CONFIG PROBLEM (payments disabled):", paymentConfigError);
}

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
const favoritesCollection = db.collection("favorites");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");
const reviewsCollection = db.collection("reviews");

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
      const user = await usersCollection.findOne({
        email: req.decoded.email,
      });

      if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).send({ message: "forbidden access" });
      }

      req.userRole = user.role;
      next();
    } catch (error) {
      console.error("Role verification failed:", error.message);
      res.status(500).send({ message: "Server error" });
    }
  };
};

const verifyOwner = verifyRole("owner");
const verifyAdmin = verifyRole("admin");

// Proves who the user is, using a token signed by Firebase.
// The email always comes from this token, never from the request body.
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  if (!idToken) {
    return res.status(401).send({ message: "Please sign in first" });
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(idToken);

    if (!decoded.email) {
      return res.status(401).send({ message: "A valid email is required" });
    }

    if (
      REQUIRE_VERIFIED_EMAIL &&
      decoded.firebase?.sign_in_provider === "password" &&
      !decoded.email_verified
    ) {
      return res
        .status(403)
        .send({ message: "Please verify your email address first" });
    }

    req.firebaseUser = {
      uid: decoded.uid,
      email: decoded.email.toLowerCase(),
    };
    next();
  } catch (error) {
    console.error("Firebase token check failed:", error.code, error.message);
    res.status(401).send({ message: "Invalid or expired sign-in" });
  }
};

// Refunds a Stripe payment. Returns true when the money is refunded.
const refundPayment = async (paymentIntentId) => {
  try {
    await stripe.refunds.create({ payment_intent: paymentIntentId });
    return true;
  } catch (error) {
    if (error.code === "charge_already_refunded") return true;
    console.error("Refund failed:", paymentIntentId, error.message);
    return false;
  }
};

// Refunds a booking's fee and records the result. Safe to retry.
const refundBooking = async (booking) => {
  if (!["paid", "refund_failed"].includes(booking.paymentStatus)) return null;

  const refunded = await refundPayment(booking.transactionId);

  await bookingsCollection.updateOne(
    { _id: booking._id },
    { $set: { paymentStatus: refunded ? "refunded" : "refund_failed" } }
  );
  await paymentsCollection.updateOne(
    { transactionId: booking.transactionId },
    { $set: { refunded } }
  );

  return refunded;
};

// Convert stored USD rent to BDT.
const rentInBdt = (rentUsd) =>
  Math.round(Number(rentUsd) * BDT_PER_USD * 100) / 100;

// Reservation fee in BDT: 10% of the rent in BDT.
const feeInBdt = (rentUsd) =>
  Math.round(rentInBdt(rentUsd) * RESERVATION_RATE * 100) / 100;

// Convert the BDT fee to USD cents for Stripe (Stripe minimum is 50 cents).
const chargeInMinorUnits = (feeBdt) =>
  Math.max(50, Math.round((feeBdt / BDT_PER_USD) * 100));

// Makes user text safe to use inside a regex search.
const escapeRegex = (text) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RENT_TYPES = ["Monthly", "Weekly", "Daily"];
const ROLES = ["tenant", "owner", "admin"];

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Checks and cleans the property fields sent by the owner form.
// Returns { error } or { data }.
const validatePropertyInput = (body) => {
  const {
    title,
    description,
    location,
    type,
    rent,
    rentType,
    bedrooms,
    bathrooms,
    size,
    amenities,
    images,
    extraFeatures,
  } = body;

  const cleanTitle = typeof title === "string" ? title.trim() : "";
  const cleanDescription =
    typeof description === "string" ? description.trim() : "";
  const cleanLocation = typeof location === "string" ? location.trim() : "";
  const cleanType = typeof type === "string" ? type.trim() : "";

  if (!cleanTitle || !cleanDescription || !cleanLocation || !cleanType) {
    return {
      error: "Title, description, location and type are required",
    };
  }

  if (!RENT_TYPES.includes(rentType)) {
    return { error: "Invalid rent type" };
  }

  const rentNumber = Number(rent);
  const bedroomsNumber = Number(bedrooms);
  const bathroomsNumber = Number(bathrooms);
  const sizeNumber = Number(size);

  if (!(rentNumber > 0)) {
    return { error: "Rent must be more than 0" };
  }

  if (
    !Number.isInteger(bedroomsNumber) ||
    bedroomsNumber < 0 ||
    !Number.isInteger(bathroomsNumber) ||
    bathroomsNumber < 0
  ) {
    return {
      error: "Bedrooms and bathrooms must be whole numbers",
    };
  }

  if (!(sizeNumber > 0)) {
    return { error: "Size must be more than 0" };
  }

  const cleanImages = Array.isArray(images)
    ? images
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter((url) => /^https?:\/\//i.test(url))
        .slice(0, 6)
    : [];

  if (cleanImages.length === 0) {
    return { error: "Add at least one valid image link" };
  }

  const cleanAmenities = Array.isArray(amenities)
    ? amenities
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .slice(0, 20)
    : [];

  return {
    data: {
      title: cleanTitle,
      description: cleanDescription,
      location: cleanLocation,
      type: cleanType,
      rent: rentNumber,
      rentType,
      bedrooms: bedroomsNumber,
      bathrooms: bathroomsNumber,
      size: sizeNumber,
      amenities: cleanAmenities,
      images: cleanImages,
      extraFeatures:
        typeof extraFeatures === "string"
          ? extraFeatures.trim()
          : "",
    },
  };
};

// ---------- Auth routes ----------

app.get("/", (req, res) => {
  res.send("RentNest server is running");
});

// A login token is issued only to someone Firebase has verified,
// and only when their MongoDB user profile exists.
app.post("/jwt", verifyFirebaseToken, async (req, res) => {
  try {
    const { email } = req.firebaseUser;

    const user = await usersCollection.findOne({ email });

    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    const token = jwt.sign(
      { email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.send({ token });
  } catch (error) {
    console.error("JWT creation failed:", error.message);
    res.status(500).send({ message: "Failed to create token" });
  }
});

// ---------- User routes ----------

// Public registration may create only tenant or owner profiles.
// Existing profiles retain their original role. Admins are never created here.
app.post("/users", verifyFirebaseToken, async (req, res) => {
  try {
    const { email } = req.firebaseUser;

    const name =
      typeof req.body.name === "string"
        ? req.body.name.trim().slice(0, 100)
        : "";

    const photo =
      typeof req.body.photo === "string"
        ? req.body.photo.trim().slice(0, 2048)
        : "";

    const requestedRole = req.body.role;

    if (
      requestedRole !== undefined &&
      !["tenant", "owner"].includes(requestedRole)
    ) {
      return res.status(400).send({
        message: "Registration role must be tenant or owner",
      });
    }

    const existing = await usersCollection.findOne({ email });

    if (existing) {
      return res.send({
        message: "User already exists",
        inserted: false,
        role: existing.role,
      });
    }

    const newUser = {
      name,
      email,
      photo,
      role: requestedRole || "tenant",
      createdAt: new Date(),
    };

    const result = await usersCollection.insertOne(newUser);

    res.status(201).send({
      inserted: true,
      insertedId: result.insertedId,
      role: newUser.role,
    });
  } catch (error) {
    // Two sign-ups at the same moment: the unique email index rejects the second.
    if (error.code === 11000) {
      const existing = await usersCollection.findOne({
        email: req.firebaseUser.email,
      });

      if (existing) {
        return res.send({
          message: "User already exists",
          inserted: false,
          role: existing.role,
        });
      }
    }

    console.error("Failed to save user:", error.message);
    res.status(500).send({ message: "Failed to save user" });
  }
});

// A user can retrieve only their own saved role.
app.get("/users/role/:email", verifyToken, async (req, res) => {
  try {
    const requestedEmail = req.params.email.trim().toLowerCase();
    const authenticatedEmail = req.decoded.email.trim().toLowerCase();

    if (requestedEmail !== authenticatedEmail) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const user = await usersCollection.findOne({
      email: authenticatedEmail,
    });

    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send({ role: user.role });
  } catch (error) {
    console.error("Failed to retrieve user role:", error.message);
    res.status(500).send({ message: "Failed to retrieve user role" });
  }
});

 // ---------- Property routes ----------

// All approved properties with backend search, filter, sort and pagination.
app.get("/properties", async (req, res) => {
  try {
    const { location, type, minPrice, maxPrice, sort, page, limit } =
      req.query;

    const query = { status: "approved" };

    if (location && location.trim()) {
      query.location = {
        $regex: escapeRegex(location.trim()),
        $options: "i",
      };
    }

    if (type) {
      query.type = type;
    }

    const rentRange = {};

    if (minPrice !== undefined && minPrice !== "" && !isNaN(minPrice)) {
      rentRange.$gte = Number(minPrice);
    }

    if (maxPrice !== undefined && maxPrice !== "" && !isNaN(maxPrice)) {
      rentRange.$lte = Number(maxPrice);
    }

    if (Object.keys(rentRange).length > 0) {
      query.rent = rentRange;
    }

    let sortOption = { createdAt: -1 };

    if (sort === "price-asc") {
      sortOption = { rent: 1, createdAt: -1 };
    }

    if (sort === "price-desc") {
      sortOption = { rent: -1, createdAt: -1 };
    }

    const pageNumber = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(24, Math.max(1, parseInt(limit) || 6));

    const total = await propertiesCollection.countDocuments(query);

    const properties = await propertiesCollection
      .find(query, { projection: { ownerEmail: 0 } })
      .sort(sortOption)
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    res.send({
      properties,
      total,
      page: pageNumber,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    console.error("Failed to load properties:", error.message);
    res.status(500).send({ message: "Failed to load properties" });
  }
});

// Keep this above "/properties/:id".
app.get("/properties/featured", async (req, res) => {
  try {
    const result = await propertiesCollection
      .find({ status: "approved" }, { projection: { ownerEmail: 0 } })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load featured properties" });
  }
});

// The logged-in owner's own properties, regardless of status.
app.get("/properties/mine", verifyToken, verifyOwner, async (req, res) => {
  try {
    const result = await propertiesCollection
      .find({ ownerEmail: req.decoded.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load your properties" });
  }
});

// One of the owner's properties for the update form.
app.get("/properties/mine/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).send({ message: "Property not found" });
    }

    const property = await propertiesCollection.findOne({
      _id: new ObjectId(id),
      ownerEmail: req.decoded.email,
    });

    if (!property) {
      return res.status(404).send({ message: "Property not found" });
    }

    res.send(property);
  } catch (error) {
    res.status(500).send({ message: "Failed to load property" });
  }
});

// Get one property.
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

    // Pending or rejected listings are visible only to their owner and admins.
    if (property.status !== "approved") {
      const viewer = await usersCollection.findOne({
        email: req.decoded.email,
      });

      const allowed =
        property.ownerEmail === req.decoded.email || viewer?.role === "admin";

      if (!allowed) {
        return res.status(404).send({ message: "Property not found" });
      }
    }

    res.send(property);
  } catch (error) {
    res.status(500).send({ message: "Failed to load property" });
  }
});

// Owners add properties. New properties require admin approval.
app.post("/properties", verifyToken, verifyOwner, async (req, res) => {
  try {
    const { error, data } = validatePropertyInput(req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    const owner = await usersCollection.findOne({
      email: req.decoded.email,
    });

    const property = {
      ...data,
      status: "pending",
      ownerName: owner?.name || "",
      ownerEmail: req.decoded.email,
      ownerPhoto: owner?.photo || "",
      createdAt: new Date(),
    };

    const result = await propertiesCollection.insertOne(property);

    res.send({
      inserted: true,
      propertyId: result.insertedId,
    });
  } catch (error) {
    res.status(500).send({ message: "Failed to add property" });
  }
});

// Owners can update only their own properties.
app.put("/properties/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).send({ message: "Property not found" });
    }

    const filter = {
      _id: new ObjectId(id),
      ownerEmail: req.decoded.email,
    };

    const existing = await propertiesCollection.findOne(filter);

    if (!existing) {
      return res.status(404).send({ message: "Property not found" });
    }

    const { error, data } = validatePropertyInput(req.body);

    if (error) {
      return res.status(400).send({ message: error });
    }

    const update = {
      $set: {
        ...data,
        updatedAt: new Date(),
      },
    };

    // Resubmit rejected listings for review after editing.
    if (existing.status === "rejected") {
      update.$set.status = "pending";
      update.$unset = { rejectionFeedback: "" };
    }

    await propertiesCollection.updateOne(filter, update);

    res.send({
      updated: true,
      status:
        existing.status === "rejected" ? "pending" : existing.status,
    });
  } catch (error) {
    res.status(500).send({ message: "Failed to update property" });
  }
});

// Owners can delete only their own properties.
app.delete("/properties/:id", verifyToken, verifyOwner, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(404).send({ message: "Property not found" });
    }

    const result = await propertiesCollection.deleteOne({
      _id: new ObjectId(id),
      ownerEmail: req.decoded.email,
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "Property not found" });
    }

    res.send({ deleted: true });
  } catch (error) {
    res.status(500).send({ message: "Failed to delete property" });
  }
});

 // ---------- Review routes ----------

// Up to 4 highly rated reviews for public display.
// The reviewer's email is not exposed.
app.get("/reviews/featured", async (req, res) => {
  try {
    const result = await reviewsCollection
      .find(
        { rating: { $gte: 4 } },
        {
          projection: {
            reviewerName: 1,
            reviewerPhoto: 1,
            rating: 1,
            comment: 1,
            createdAt: 1,
          },
        }
      )
      .sort({ rating: -1, createdAt: -1 })
      .limit(4)
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load reviews" });
  }
});

// Reviews for one property, newest first.
app.get("/reviews/:propertyId", verifyToken, async (req, res) => {
  try {
    const result = await reviewsCollection
      .find(
        { propertyId: req.params.propertyId },
        { projection: { reviewerEmail: 0 } }
      )
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load reviews" });
  }
});

// Only tenants can post one review per property.
app.post("/reviews", verifyToken, verifyRole("tenant"), async (req, res) => {
  try {
    const { propertyId, rating, comment } = req.body;

    if (!ObjectId.isValid(propertyId)) {
      return res.status(400).send({ message: "Invalid property" });
    }

    const ratingNumber = Number(rating);

    if (
      !Number.isInteger(ratingNumber) ||
      ratingNumber < 1 ||
      ratingNumber > 5
    ) {
      return res.status(400).send({
        message: "Rating must be from 1 to 5",
      });
    }

    const text = typeof comment === "string" ? comment.trim() : "";

    if (!text) {
      return res.status(400).send({
        message: "Please write a comment",
      });
    }

    if (text.length > 500) {
      return res.status(400).send({
        message: "Comment must be 500 characters or less",
      });
    }

    const property = await propertiesCollection.findOne({
      _id: new ObjectId(propertyId),
    });

    if (!property) {
      return res.status(404).send({ message: "Property not found" });
    }

    const existing = await reviewsCollection.findOne({
      propertyId,
      reviewerEmail: req.decoded.email,
    });

    if (existing) {
      return res.status(409).send({
        message: "You have already reviewed this property",
      });
    }

    // Reviewer details come from the saved account.
    const reviewer = await usersCollection.findOne({
      email: req.decoded.email,
    });

    const review = {
      propertyId,
      reviewerName: reviewer?.name || "Tenant",
      reviewerEmail: req.decoded.email,
      reviewerPhoto: reviewer?.photo || "",
      rating: ratingNumber,
      comment: text,
      createdAt: new Date(),
    };

    const result = await reviewsCollection.insertOne(review);

    res.send({
      inserted: true,
      review: {
        ...review,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    res.status(500).send({ message: "Failed to save review" });
  }
});

// ---------- Favorites routes ----------

// Get the logged-in user's favorites.
app.get("/favorites", verifyToken, async (req, res) => {
  try {
    const result = await favoritesCollection
      .find({ userEmail: req.decoded.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load favorites" });
  }
});

// Check whether a property is already a favorite.
app.get("/favorites/check/:propertyId", verifyToken, async (req, res) => {
  try {
    const favorite = await favoritesCollection.findOne({
      userEmail: req.decoded.email,
      propertyId: req.params.propertyId,
    });

    res.send({
      favorited: !!favorite,
      favoriteId: favorite ? favorite._id : null,
    });
  } catch (error) {
    res.status(500).send({ message: "Failed to check favorite" });
  }
});

// Add a property to favorites.
app.post("/favorites", verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.body;

    if (!ObjectId.isValid(propertyId)) {
      return res.status(400).send({ message: "Invalid property" });
    }

    const existing = await favoritesCollection.findOne({
      userEmail: req.decoded.email,
      propertyId,
    });

    if (existing) {
      return res.send({
        message: "Already in favorites",
        inserted: false,
      });
    }

    const property = await propertiesCollection.findOne({
      _id: new ObjectId(propertyId),
    });

    if (!property) {
      return res.status(404).send({ message: "Property not found" });
    }

    const favorite = {
      userEmail: req.decoded.email,
      propertyId,
      title: property.title,
      location: property.location,
      type: property.type,
      rent: property.rent,
      rentType: property.rentType,
      image: property.images?.[0] || "",
      createdAt: new Date(),
    };

    const result = await favoritesCollection.insertOne(favorite);

    res.send({
      inserted: true,
      favoriteId: result.insertedId,
    });
  } catch (error) {
    res.status(500).send({ message: "Failed to add favorite" });
  }
});

// Remove a favorite belonging to the logged-in user.
app.delete("/favorites/:id", verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid favorite" });
    }

    const result = await favoritesCollection.deleteOne({
      _id: new ObjectId(req.params.id),
      userEmail: req.decoded.email,
    });

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to remove favorite" });
  }
});

 // ---------- Payment and booking routes ----------

// Create a Stripe PaymentIntent for a property reservation.
app.post("/create-payment-intent", verifyToken, async (req, res) => {
  if (paymentConfigError) {
    return res.status(500).send({ message: "Payments are not configured yet" });
  }
  try {
    const { propertyId } = req.body;

    if (!ObjectId.isValid(propertyId)) {
      return res.status(400).send({ message: "Invalid property" });
    }

    const property = await propertiesCollection.findOne({
      _id: new ObjectId(propertyId),
    });

    if (!property || property.status !== "approved") {
      return res.status(404).send({
        message: "Property not available",
      });
    }

    if (property.ownerEmail === req.decoded.email) {
      return res.status(400).send({
        message: "You can't book your own property",
      });
    }

    const feeBdt = feeInBdt(property.rent);
    const amount = chargeInMinorUnits(feeBdt);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
      metadata: {
        propertyId,
        tenantEmail: req.decoded.email,
        feeBdt: String(feeBdt),
      },
    });

    res.send({
      clientSecret: paymentIntent.client_secret,
      amount: feeBdt, // the fee in BDT, for display
      currency: "BDT",
      chargedAmount: amount / 100, // what the card is charged
      chargedCurrency: "USD",
    });
  } catch (error) {
    console.error("Failed to start payment:", error.message);
    res.status(500).send({ message: "Failed to start payment" });
  }
});

// Save a verified successful payment and create the booking.
// Safe to retry: the same payment always gives the same booking.
app.post("/payments", verifyToken, async (req, res) => {
  try {
    const { paymentIntentId, propertyId, moveInDate, phone, notes } = req.body;

    if (typeof paymentIntentId !== "string" || !ObjectId.isValid(propertyId)) {
      return res.status(400).send({
        message: "Invalid payment details",
      });
    }

    const cleanPhone = typeof phone === "string" ? phone.trim() : "";
    const cleanNotes =
      typeof notes === "string" ? notes.trim().slice(0, 500) : "";

    const moveIn = new Date(moveInDate);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    if (!/^[0-9+\-\s()]{6,20}$/.test(cleanPhone)) {
      return res.status(400).send({ message: "Enter a valid phone number" });
    }

    if (
      typeof moveInDate !== "string" ||
      isNaN(moveIn) ||
      moveIn < startOfToday
    ) {
      return res.status(400).send({ message: "Choose a valid move-in date" });
    }

    const respond = async (booking) => {
      await paymentsCollection.updateOne(
        { transactionId: paymentIntentId },
        {
          $setOnInsert: {
            transactionId: paymentIntentId,
            bookingId: booking._id.toString(),
            propertyId: booking.propertyId,
            propertyTitle: booking.propertyTitle,
            tenantName: booking.tenantName,
            tenantEmail: booking.tenantEmail,
            ownerName: booking.ownerName,
            ownerEmail: booking.ownerEmail,
            amount: booking.amount,
            date: new Date(),
          },
        },
        { upsert: true }
      );

      return res.send({
        success: true,
        bookingId: booking._id.toString(),
        transactionId: paymentIntentId,
        amount: booking.amount,
      });
    };

    // A retry of an already-saved payment returns the same booking.
    let booking = await bookingsCollection.findOne({
      transactionId: paymentIntentId,
    });

    if (booking) {
      if (booking.tenantEmail !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      return respond(booking);
    }

    // Verify the payment directly with Stripe.
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (
      intent.status !== "succeeded" ||
      intent.metadata.tenantEmail !== req.decoded.email ||
      intent.metadata.propertyId !== propertyId ||
      !(Number(intent.metadata.feeBdt) > 0)
    ) {
      return res.status(400).send({
        message: "Payment could not be verified",
      });
    }

    const property = await propertiesCollection.findOne({
      _id: new ObjectId(propertyId),
    });

    // The money is already taken at this point, so refund on any failure.
    if (
      !property ||
      property.status !== "approved" ||
      property.ownerEmail === req.decoded.email
    ) {
      const refunded = await refundPayment(paymentIntentId);

      return res.status(409).send({
        message: refunded
          ? "This property is no longer available. Your payment has been refunded."
          : "This property is no longer available. Please contact support about your refund.",
      });
    }

    const tenant = await usersCollection.findOne({
      email: req.decoded.email,
    });

    const newBooking = {
      propertyId,
      propertyTitle: property.title,
      propertyImage: property.images?.[0] || "",
      location: property.location,
      tenantEmail: req.decoded.email,
      tenantName: tenant?.name || "",
      tenantPhoto: tenant?.photo || "",
      ownerEmail: property.ownerEmail,
      ownerName: property.ownerName,
      moveInDate,
      phone: cleanPhone,
      notes: cleanNotes,
      amount: Number(intent.metadata.feeBdt), // fee in BDT
      chargedAmount: intent.amount / 100,
      chargedCurrency: intent.currency,
      bookingStatus: "pending",
      paymentStatus: "paid",
      transactionId: paymentIntentId,
      createdAt: new Date(),
    };

    try {
      const result = await bookingsCollection.insertOne(newBooking);
      booking = { ...newBooking, _id: result.insertedId };
    } catch (error) {
      // A duplicate request got there first: reuse its booking.
      if (error.code !== 11000) throw error;

      booking = await bookingsCollection.findOne({
        transactionId: paymentIntentId,
      });
    }

    return respond(booking);
  } catch (error) {
    console.error("Failed to save booking:", error.message);
    res.status(500).send({ message: "Failed to save booking" });
  }
});

// The logged-in tenant's bookings, newest first.
app.get("/bookings/my", verifyToken, async (req, res) => {
  try {
    const result = await bookingsCollection
      .find({ tenantEmail: req.decoded.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load bookings" });
  }
});

// Booking requests for the logged-in owner's properties.
app.get("/bookings/requests", verifyToken, verifyOwner, async (req, res) => {
  try {
    const result = await bookingsCollection
      .find({ ownerEmail: req.decoded.email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({
      message: "Failed to load booking requests",
    });
  }
});

// The owner approves or rejects a pending booking on their property.
app.patch(
  "/bookings/:id/status",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(404).send({ message: "Booking not found" });
      }

      if (status !== "approved" && status !== "rejected") {
        return res.status(400).send({ message: "Invalid status" });
      }

      const result = await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          ownerEmail: req.decoded.email,
          bookingStatus: "pending",
        },
        {
          $set: {
            bookingStatus: status,
            decidedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({
          message: "Booking not found or already decided",
        });
      }

      // A rejected booking gets its reservation fee back.
      let refunded = null;

      if (status === "rejected") {
        const booking = await bookingsCollection.findOne({
          _id: new ObjectId(id),
        });

        refunded = await refundBooking(booking);
      }

      res.send({ updated: true, status, refunded });
    } catch (error) {
      res.status(500).send({ message: "Failed to update booking" });
    }
  }
);

 // ---------- Owner analytics ----------

// Summary cards and earnings for the last 12 months.
app.get("/owner/stats", verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerEmail = req.decoded.email;
    const now = new Date();
    const months = [];

    // Twelve months ending with the current month (UTC), oldest first.
    for (let i = 11; i >= 0; i--) {
      const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
      );

      months.push({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        label: `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`,
        earnings: 0,
      });
    }

    const startDate = new Date(
      Date.UTC(months[0].year, months[0].month - 1, 1)
    );

    const [totalProperties, totalBookings, totals, monthly] =
      await Promise.all([
        propertiesCollection.countDocuments({ ownerEmail }),

        bookingsCollection.countDocuments({
          ownerEmail,
          bookingStatus: "approved",
        }),

        paymentsCollection
          .aggregate([
            { $match: { ownerEmail, refunded: { $ne: true } } },
            {
              $group: {
                _id: null,
                total: { $sum: "$amount" },
              },
            },
          ])
          .toArray(),

        paymentsCollection
          .aggregate([
            {
              $match: {
                ownerEmail,
                refunded: { $ne: true },
                date: { $gte: startDate },
              },
            },
            {
              $group: {
                _id: {
                  year: { $year: "$date" },
                  month: { $month: "$date" },
                },
                total: { $sum: "$amount" },
              },
            },
          ])
          .toArray(),
      ]);

    // Months without payments retain their zero earnings.
    monthly.forEach((row) => {
      const slot = months.find(
        (month) =>
          month.year === row._id.year &&
          month.month === row._id.month
      );

      if (slot) {
        slot.earnings = Math.round(row.total * 100) / 100;
      }
    });

    res.send({
      totalEarnings: Math.round((totals[0]?.total || 0) * 100) / 100,
      totalProperties,
      totalBookings,
      monthlyEarnings: months.map(({ label, earnings }) => ({
        month: label,
        earnings,
      })),
    });
  } catch (error) {
    console.error("Failed to load owner statistics:", error.message);
    res.status(500).send({ message: "Failed to load statistics" });
  }
});

// ---------- Admin routes ----------

// All users, newest first.
app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await usersCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load users" });
  }
});

// Change a user's role. Admins cannot change their own role.
app.patch(
  "/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(404).send({ message: "User not found" });
      }

      if (!ROLES.includes(role)) {
        return res.status(400).send({ message: "Invalid role" });
      }

      const target = await usersCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!target) {
        return res.status(404).send({ message: "User not found" });
      }

      if (target.email === req.decoded.email) {
        return res.status(400).send({
          message: "You can't change your own role",
        });
      }

      await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );

      res.send({ updated: true, role });
    } catch (error) {
      res.status(500).send({ message: "Failed to change role" });
    }
  }
);

// All properties, any status, newest first.
app.get("/admin/properties", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await propertiesCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load properties" });
  }
});

// Get one property for the admin update form.
app.get(
  "/admin/properties/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
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
  }
);

// Admins approve properties or reject them with feedback.
app.patch(
  "/admin/properties/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, feedback } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(404).send({ message: "Property not found" });
      }

      if (status !== "approved" && status !== "rejected") {
        return res.status(400).send({ message: "Invalid status" });
      }

      const update = {
        $set: {
          status,
          reviewedAt: new Date(),
        },
      };

      if (status === "rejected") {
        const text =
          typeof feedback === "string" ? feedback.trim() : "";

        if (!text) {
          return res.status(400).send({
            message: "Please write the rejection feedback",
          });
        }

        if (text.length > 500) {
          return res.status(400).send({
            message: "Feedback must be 500 characters or less",
          });
        }

        update.$set.rejectionFeedback = text;
      } else {
        update.$unset = { rejectionFeedback: "" };
      }

      const result = await propertiesCollection.updateOne(
        { _id: new ObjectId(id) },
        update
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Property not found" });
      }

      res.send({ updated: true, status });
    } catch (error) {
      res.status(500).send({ message: "Failed to update status" });
    }
  }
);

// Admins can edit any property without changing its owner or status.
app.put(
  "/admin/properties/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(404).send({ message: "Property not found" });
      }

      const { error, data } = validatePropertyInput(req.body);

      if (error) {
        return res.status(400).send({ message: error });
      }

      const result = await propertiesCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            ...data,
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Property not found" });
      }

      res.send({ updated: true });
    } catch (error) {
      res.status(500).send({ message: "Failed to update property" });
    }
  }
);

// Admins can delete any property.
app.delete(
  "/admin/properties/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(404).send({ message: "Property not found" });
      }

      const result = await propertiesCollection.deleteOne({
        _id: new ObjectId(id),
      });

      if (result.deletedCount === 0) {
        return res.status(404).send({ message: "Property not found" });
      }

      res.send({ deleted: true });
    } catch (error) {
      res.status(500).send({ message: "Failed to delete property" });
    }
  }
);

// ---------- Admin booking routes ----------

// All bookings, newest first.
app.get(
  "/admin/bookings",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const result = await bookingsCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    } catch (error) {
      console.error("Failed to load admin bookings:", error.message);
      res.status(500).send({
        message: "Failed to load bookings",
      });
    }
  }
);

// Get one booking by its MongoDB ID.
app.get(
  "/admin/bookings/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(404).send({
          message: "Booking not found",
        });
      }

      const booking = await bookingsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!booking) {
        return res.status(404).send({
          message: "Booking not found",
        });
      }

      res.send(booking);
    } catch (error) {
      console.error("Failed to load admin booking:", error.message);
      res.status(500).send({
        message: "Failed to load booking",
      });
    }
  }
);

// Admins can update a booking's status.
app.patch(
  "/admin/bookings/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { bookingStatus } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(404).send({
          message: "Booking not found",
        });
      }

      const allowedStatuses = [
        "pending",
        "approved",
        "rejected",
        "cancelled",
      ];

      if (!allowedStatuses.includes(bookingStatus)) {
        return res.status(400).send({
          message: "Invalid booking status",
        });
      }

      const booking = await bookingsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!booking) {
        return res.status(404).send({
          message: "Booking not found",
        });
      }

      const reopening = ["pending", "approved"].includes(bookingStatus);

      if (reopening && booking.paymentStatus === "refunded") {
        return res.status(400).send({
          message: "This booking was refunded and can't be reopened",
        });
      }

      await bookingsCollection.updateOne(
        { _id: booking._id },
        {
          $set: {
            bookingStatus,
            updatedAt: new Date(),
          },
        }
      );

      // Rejected or cancelled bookings get their reservation fee back.
      let refunded = null;

      if (["rejected", "cancelled"].includes(bookingStatus)) {
        refunded = await refundBooking(booking);
      }

      res.send({
        updated: true,
        bookingStatus,
        refunded,
      });
    } catch (error) {
      console.error("Failed to update admin booking:", error.message);
      res.status(500).send({
        message: "Failed to update booking status",
      });
    }
  }
);
// ---------- Admin transaction routes ----------

// All transactions, newest first.
app.get(
  "/admin/transactions",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const result = await paymentsCollection
        .find({})
        .sort({ date: -1 })
        .toArray();

      res.send(result);
    } catch (error) {
      console.error(
        "Failed to load admin transactions:",
        error.message
      );

      res.status(500).send({
        message: "Failed to load transactions",
      });
    }
  }
);

// Get one transaction by its MongoDB ID.
app.get(
  "/admin/transactions/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(404).send({
          message: "Transaction not found",
        });
      }

      const transaction = await paymentsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!transaction) {
        return res.status(404).send({
          message: "Transaction not found",
        });
      }

      res.send(transaction);
    } catch (error) {
      console.error(
        "Failed to load admin transaction:",
        error.message
      );

      res.status(500).send({
        message: "Failed to load transaction",
      });
    }
  }
);

// Find transactions by their Stripe transaction ID.
app.get(
  "/admin/transactions/stripe/:transactionId",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { transactionId } = req.params;

      const transaction = await paymentsCollection.findOne({
        transactionId,
      });

      if (!transaction) {
        return res.status(404).send({
          message: "Transaction not found",
        });
      }

      res.send(transaction);
    } catch (error) {
      console.error(
        "Failed to find Stripe transaction:",
        error.message
      );

      res.status(500).send({
        message: "Failed to find transaction",
      });
    }
  }
);
// ---------- Server startup and exports ----------

async function startServer() {
  try {
    await client.connect();
    await db.command({ ping: 1 });

    // These rules stop duplicate accounts, bookings and payments.
    // If old data already has duplicates, log it and keep the site running.
    const indexJobs = [
      usersCollection.createIndex({ email: 1 }, { unique: true }),
      paymentsCollection.createIndex({ transactionId: 1 }, { unique: true }),
      bookingsCollection.createIndex({ transactionId: 1 }, { unique: true }),
    ];
    (await Promise.allSettled(indexJobs)).forEach((r) => {
      if (r.status === "rejected") {
        console.error("Could not create unique index:", r.reason?.message);
      }
    });

    console.log("MongoDB connected to rentnestDB");

    app.listen(port, () => {
      console.log(`RentNest server is running on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to start RentNest:", error);
    await client.close().catch(() => {});
    process.exit(1);
  }
}

startServer();

export default app;