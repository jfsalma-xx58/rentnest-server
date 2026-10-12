import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// The reservation fee is 10% of the rent
const RESERVATION_RATE = 0.1;

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

const verifyOwner = verifyRole("owner");
// Ready to use on admin routes later:
// const verifyAdmin = verifyRole("admin");

// Reservation fee in cents (Stripe minimum is 50 cents)
const feeInCents = (rent) =>
  Math.max(50, Math.round(Number(rent) * RESERVATION_RATE * 100));

// Makes user text safe to use inside a regex search
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RENT_TYPES = ["Monthly", "Weekly", "Daily"];

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

// All approved properties with backend search, filter, sort and pagination
app.get("/properties", async (req, res) => {
  try {
    const { location, type, minPrice, maxPrice, sort, page, limit } = req.query;

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
    if (sort === "price-asc") sortOption = { rent: 1, createdAt: -1 };
    if (sort === "price-desc") sortOption = { rent: -1, createdAt: -1 };

    const pageNumber = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(24, Math.max(1, parseInt(limit) || 6));

    const total = await propertiesCollection.countDocuments(query);
    const properties = await propertiesCollection
      .find(query)
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
    res.status(500).send({ message: "Failed to load properties" });
  }
});

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

// An owner adds a property. It starts as "pending" until an admin approves it
app.post("/properties", verifyToken, verifyOwner, async (req, res) => {
  try {
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
    } = req.body;

    const cleanTitle = typeof title === "string" ? title.trim() : "";
    const cleanDescription =
      typeof description === "string" ? description.trim() : "";
    const cleanLocation = typeof location === "string" ? location.trim() : "";
    const cleanType = typeof type === "string" ? type.trim() : "";

    if (!cleanTitle || !cleanDescription || !cleanLocation || !cleanType) {
      return res.status(400).send({
        message: "Title, description, location and type are required",
      });
    }

    if (!RENT_TYPES.includes(rentType)) {
      return res.status(400).send({ message: "Invalid rent type" });
    }

    const rentNumber = Number(rent);
    const bedroomsNumber = Number(bedrooms);
    const bathroomsNumber = Number(bathrooms);
    const sizeNumber = Number(size);
    if (!(rentNumber > 0)) {
      return res.status(400).send({ message: "Rent must be more than 0" });
    }
    if (
      !Number.isInteger(bedroomsNumber) ||
      bedroomsNumber < 0 ||
      !Number.isInteger(bathroomsNumber) ||
      bathroomsNumber < 0
    ) {
      return res
        .status(400)
        .send({ message: "Bedrooms and bathrooms must be whole numbers" });
    }
    if (!(sizeNumber > 0)) {
      return res.status(400).send({ message: "Size must be more than 0" });
    }

    const cleanImages = Array.isArray(images)
      ? images
          .map((url) => (typeof url === "string" ? url.trim() : ""))
          .filter((url) => /^https?:\/\//i.test(url))
          .slice(0, 6)
      : [];
    if (cleanImages.length === 0) {
      return res
        .status(400)
        .send({ message: "Add at least one valid image link" });
    }

    const cleanAmenities = Array.isArray(amenities)
      ? amenities
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
          .slice(0, 20)
      : [];

    // Owner details come from the saved account, so they can't be faked
    const owner = await usersCollection.findOne({ email: req.decoded.email });

    const property = {
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
        typeof extraFeatures === "string" ? extraFeatures.trim() : "",
      status: "pending",
      ownerName: owner?.name || "",
      ownerEmail: req.decoded.email,
      ownerPhoto: owner?.photo || "",
      createdAt: new Date(),
    };

    const result = await propertiesCollection.insertOne(property);
    res.send({ inserted: true, propertyId: result.insertedId });
  } catch (error) {
    res.status(500).send({ message: "Failed to add property" });
  }
});

// ---------- Review routes ----------

// Reviews for one property, newest first
app.get("/reviews/:propertyId", verifyToken, async (req, res) => {
  try {
    const result = await reviewsCollection
      .find({ propertyId: req.params.propertyId })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to load reviews" });
  }
});

// Only tenants can post, one review per tenant per property
app.post("/reviews", verifyToken, verifyRole("tenant"), async (req, res) => {
  try {
    const { propertyId, rating, comment } = req.body;

    if (!ObjectId.isValid(propertyId)) {
      return res.status(400).send({ message: "Invalid property" });
    }

    const ratingNumber = Number(rating);
    if (!Number.isInteger(ratingNumber) || ratingNumber < 1 || ratingNumber > 5) {
      return res.status(400).send({ message: "Rating must be from 1 to 5" });
    }

    const text = typeof comment === "string" ? comment.trim() : "";
    if (!text) {
      return res.status(400).send({ message: "Please write a comment" });
    }
    if (text.length > 500) {
      return res
        .status(400)
        .send({ message: "Comment must be 500 characters or less" });
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
      return res
        .status(409)
        .send({ message: "You have already reviewed this property" });
    }

    // Name and photo come from the saved account, so they can't be faked
    const reviewer = await usersCollection.findOne({ email: req.decoded.email });

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
    res.send({ inserted: true, review: { ...review, _id: result.insertedId } });
  } catch (error) {
    res.status(500).send({ message: "Failed to save review" });
  }
});

// ---------- Favorites routes ----------

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
      return res.send({ message: "Already in favorites", inserted: false });
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
    res.send({ inserted: true, favoriteId: result.insertedId });
  } catch (error) {
    res.status(500).send({ message: "Failed to add favorite" });
  }
});

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

app.post("/create-payment-intent", verifyToken, async (req, res) => {
  try {
    const { propertyId } = req.body;
    if (!ObjectId.isValid(propertyId)) {
      return res.status(400).send({ message: "Invalid property" });
    }

    const property = await propertiesCollection.findOne({
      _id: new ObjectId(propertyId),
    });
    if (!property || property.status !== "approved") {
      return res.status(404).send({ message: "Property not available" });
    }
    if (property.ownerEmail === req.decoded.email) {
      return res
        .status(400)
        .send({ message: "You can't book your own property" });
    }

    const amount = feeInCents(property.rent);
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { propertyId, tenantEmail: req.decoded.email },
    });

    res.send({ clientSecret: paymentIntent.client_secret, amount: amount / 100 });
  } catch (error) {
    res.status(500).send({ message: "Failed to start payment" });
  }
});

app.post("/payments", verifyToken, async (req, res) => {
  try {
    const { paymentIntentId, propertyId, moveInDate, phone, notes } = req.body;

    if (!paymentIntentId || !ObjectId.isValid(propertyId)) {
      return res.status(400).send({ message: "Invalid payment details" });
    }

    // If this payment was already saved, return it (safe to retry)
    const already = await paymentsCollection.findOne({
      transactionId: paymentIntentId,
    });
    if (already) {
      return res.send({
        success: true,
        bookingId: already.bookingId,
        transactionId: already.transactionId,
        amount: already.amount,
      });
    }

    // Ask Stripe directly whether the payment really succeeded
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (
      intent.status !== "succeeded" ||
      intent.metadata.tenantEmail !== req.decoded.email ||
      intent.metadata.propertyId !== propertyId
    ) {
      return res.status(400).send({ message: "Payment could not be verified" });
    }

    const property = await propertiesCollection.findOne({
      _id: new ObjectId(propertyId),
    });
    if (!property) {
      return res.status(404).send({ message: "Property not found" });
    }
    const tenant = await usersCollection.findOne({ email: req.decoded.email });

    const amount = intent.amount / 100;

    const booking = {
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
      phone,
      notes: notes || "",
      amount,
      bookingStatus: "pending",
      paymentStatus: "paid",
      transactionId: paymentIntentId,
      createdAt: new Date(),
    };
    const bookingResult = await bookingsCollection.insertOne(booking);

    const payment = {
      transactionId: paymentIntentId,
      bookingId: bookingResult.insertedId.toString(),
      propertyId,
      propertyTitle: property.title,
      tenantName: tenant?.name || "",
      tenantEmail: req.decoded.email,
      ownerName: property.ownerName,
      ownerEmail: property.ownerEmail,
      amount,
      date: new Date(),
    };
    await paymentsCollection.insertOne(payment);

    res.send({
      success: true,
      bookingId: payment.bookingId,
      transactionId: paymentIntentId,
      amount,
    });
  } catch (error) {
    res.status(500).send({ message: "Failed to save booking" });
  }
});

// The logged-in tenant's own bookings, newest first
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});