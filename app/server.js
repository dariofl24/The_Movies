const express = require("express");
const { MongoClient } = require("mongodb");
const { ChromaClient } = require("chromadb");

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://admin:admin123@localhost:27017/movies?authSource=admin";
const CHROMA_URL = new URL(process.env.CHROMA_URL || "http://localhost:8000");
const PAGE_SIZE = 24;
const SIMILAR_COUNT = 12;

const mongo = new MongoClient(MONGO_URL);
const chroma = new ChromaClient({
  host: CHROMA_URL.hostname,
  port: Number(CHROMA_URL.port) || 8000,
  ssl: CHROMA_URL.protocol === "https:",
});

const app = express();
app.set("view engine", "ejs");
app.set("views", __dirname + "/views");
app.use(express.static(__dirname + "/public"));

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function similarMovies(movies, id) {
  const col = await chroma.getCollection({ name: "movies" });
  const stored = await col.get({ ids: [String(id)], include: ["embeddings"] });
  const embedding = stored.embeddings?.[0];
  if (!embedding) return [];
  const res = await col.query({
    queryEmbeddings: [Array.from(embedding)],
    nResults: SIMILAR_COUNT + 1,
    include: ["distances"],
  });
  const ids = res.ids[0].map(Number).filter((x) => x !== id).slice(0, SIMILAR_COUNT);
  const docs = await movies.find({ id: { $in: ids } }).toArray();
  const byId = new Map(docs.map((d) => [d.id, d]));
  return ids.map((x) => byId.get(x)).filter(Boolean);
}

async function main() {
  await mongo.connect();
  const movies = mongo.db("movies").collection("movies");
  app.locals.genres = (await movies.distinct("genres")).filter(Boolean).sort();
  const genres = app.locals.genres;

  // defaults so the shared header search form renders on every page
  app.use((req, res, next) => {
    res.locals.q = "";
    res.locals.genre = "";
    next();
  });

  app.get("/healthz", (req, res) => res.send("ok"));

  app.get("/", async (req, res, next) => {
    try {
      const q = (req.query.q || "").toString().trim();
      const genre = (req.query.genre || "").toString();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      if (!q && !genre) {
        const items = await movies
          .aggregate([
            { $sample: { size: PAGE_SIZE } },
            { $project: { title: 1, id: 1, year: 1, genres: 1, poster_url: 1 } },
          ])
          .toArray();
        res.set("Cache-Control", "no-store");
        return res.render("index", { items, q, genre, genres, page: 1, pages: 1, total: await movies.estimatedDocumentCount(), random: true });
      }
      const filter = {};
      if (q) filter.title = { $regex: escapeRegExp(q), $options: "i" };
      if (genre) filter.genres = genre;
      const total = await movies.countDocuments(filter);
      const items = await movies
        .find(filter, { projection: { title: 1, id: 1, year: 1, genres: 1, poster_url: 1 } })
        .sort({ title: 1, id: 1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .toArray();
      res.render("index", { items, q, genre, genres, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, random: false });
    } catch (e) {
      next(e);
    }
  });

  app.get("/movie/:id", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const movie = Number.isNaN(id) ? null : await movies.findOne({ id });
      if (!movie) return res.status(404).render("404");
      let similar = [];
      let similarError = false;
      try {
        similar = await similarMovies(movies, id);
      } catch (e) {
        console.error("similarity query failed:", e.message);
        similarError = true;
      }
      res.render("movie", { movie, similar, similarError });
    } catch (e) {
      next(e);
    }
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send("Something went wrong");
  });

  app.listen(PORT, () => console.log(`Catalog listening on :${PORT}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
