require("dotenv").config();

const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");
const rateLimit = require("express-rate-limit");
const analyzeRouter = require("./routes/analyze");

const app = express();
const PORT = 3000;
app.use(express.json({ limit: "10kb" }));

let products = [];

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      error: {
        code: "RATE_LIMIT",
        message: "Too many requests. Please try again later.",
      },
    });
  },
});

function loadCSV() {
  return new Promise((resolve, reject) => {
    products = [];

    fs.createReadStream("./db.csv")
      .pipe(csv())
      .on("data", (row) => {
        products.push(row);
      })
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}

app.get("/api/products", (req, res) => {
  const q = req.query.q;

  if (typeof q !== "string" || q.trim() === "") {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const query = q.trim();
  const loweredQuery = query.toLowerCase();
  const mapped = products
    .filter((product) =>
      String(product["Nama Produk"] || "")
        .toLowerCase()
        .includes(loweredQuery),
    )
    .slice(0, 10);

  return res.json({
    query,
    count: mapped.length,
    results: mapped,
  });
});

app.use("/api/analyze-ingredients", analyzeLimiter, analyzeRouter);

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid JSON body.",
      },
    });
  }

  return next(err);
});

loadCSV()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to load CSV:", err);
    process.exit(1);
  });
