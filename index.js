const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
const PORT = 3000;

let products = [];

function loadCSV() {
  return new Promise((resolve, reject) => {
    products = [];

    fs.createReadStream('./db.csv')
      .pipe(csv())
      .on('data', (row) => {
        products.push(row);
      })
      .on('end', () => {
        resolve();
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

app.get('/api/products', (req, res) => {
  const q = req.query.q;

  if (typeof q !== 'string' || q.trim() === '') {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const query = q.trim();
  const loweredQuery = query.toLowerCase();
  const mapped = products
    .filter((product) =>
      String(product['Nama Produk'] || '').toLowerCase().includes(loweredQuery)
    )
    .slice(0, 10);

  return res.json({
    query,
    count: mapped.length,
    results: mapped,
  });
});

loadCSV()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to load CSV:', err);
    process.exit(1);
  });
