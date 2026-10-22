# The Movies

A movie catalog built on three pieces:

- **MongoDB** stores ~41.7k movies (loaded from a CSV).
- **ChromaDB** stores a 768-dimension embedding per movie (generated locally with Ollama), used for similarity search.
- **A Node.js web app** to browse the catalog and view movie details, with a "Similar movies" section powered by Chroma.

Everything runs with Docker Compose.

## Architecture

```mermaid
flowchart LR
    csv[/"movies_summary.csv"/]
    jsonl[/"movies_embeddings.jsonl"/]
    ollama["Ollama<br/>embeddinggemma-2:270m"]
    embed["embed_movies.py"]
    mseed["mongo-seed"]
    cseed["chroma-seed"]
    mongo[("MongoDB<br/>movies.movies")]
    chroma[("ChromaDB<br/>collection: movies")]
    web["web<br/>Express + EJS :3000"]

    csv --> mseed --> mongo
    csv --> embed
    embed <--> ollama
    embed --> jsonl --> cseed --> chroma
    mongo --> web
    chroma --> web
```

| Service        | Image / build            | Port  | Purpose                                                        |
|----------------|--------------------------|-------|----------------------------------------------------------------|
| `mongo`        | `mongo:8`                | 27017 | Movie documents                                                |
| `mongo-seed`   | `mongo:8`                | –     | One-shot job: imports the CSV and creates indexes              |
| `chroma`       | `chromadb/chroma:latest` | 8000  | Vector store                                                   |
| `chroma-seed`  | `python:3.12-slim`       | –     | One-shot job: loads the embeddings into Chroma                 |
| `web`          | `./app` (Node 22)        | 3000  | The catalog web app                                            |

The two `*-seed` jobs exit when done and skip the load if their data is already present, so re-running `docker compose up` is safe.

## Prerequisites

- Docker Desktop (Docker Engine + Compose v2)
- [Ollama](https://ollama.com) with the `embeddinggemma-2:270m` model pulled. Only needed to **regenerate** the embeddings, not to run the app.
- Python 3 (standard library only) to run `embed_movies.py`

## Project layout

```
.
├── docker-compose.yml          # mongo, mongo-seed, chroma, chroma-seed, web
├── seed.sh                     # mongo-seed: mongoimport + type conversion + indexes
├── embed_movies.py             # CSV -> Ollama -> movies_embeddings.jsonl
├── load_chroma.py              # chroma-seed: JSONL -> Chroma collection
├── movies_embeddings.jsonl     # generated embeddings (~412 MB)
├── movies_archive/
│   └── movies_summary.csv      # source dataset (41,672 movies)
└── app/                        # web application
    ├── server.js
    ├── Dockerfile
    ├── package.json
    ├── public/style.css
    └── views/                  # EJS templates (index, movie, 404, partials)
```

`movies_archive/` also holds other dataset files (`credits.csv`, `keywords.csv`, `movie_posters.csv`, `movies_metadata.csv`) that this project does not use.

## Quick start

```bash
docker compose up -d --build
docker compose logs -f mongo-seed chroma-seed   # wait for the "movies loaded" / "done" lines
```

Then open **http://localhost:3000**.

First start downloads images and installs the Chroma client, then loads ~41.7k documents into each database; allow a couple of minutes.

Stop everything (data is kept in volumes):

```bash
docker compose down
```

Wipe all data and start fresh:

```bash
docker compose down -v
```

## Data

### Source CSV

`movies_archive/movies_summary.csv` columns:
`id, title, overview, year, release_date, poster_url, cast, director, country, genres`

`cast`, `country` and `genres` are `" | "`-separated lists. Some rows have blank fields (e.g. 11 movies have no year, ~1.5k have no cast). Overviews can span multiple lines, so count rows with a real CSV parser, not `wc -l`.

### MongoDB

- Database `movies`, collection `movies`, 41,672 documents.
- `seed.sh` imports the CSV with `mongoimport`, then converts types:
  - `id`, `year` → integers
  - `release_date` → Date
  - `cast`, `country`, `genres` → arrays of strings
- Indexes: `id` (unique), `genres`, `year`, and a text index on `title` + `overview`.

Example document:

```json
{
  "id": 862,
  "title": "Toy Story",
  "year": 1995,
  "release_date": "1995-10-30T00:00:00Z",
  "poster_url": "https://image.tmdb.org/t/p/w500/uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg",
  "cast": ["Tom Hanks", "Tim Allen", "..."],
  "director": "John Lasseter",
  "country": ["United States of America"],
  "genres": ["Animation", "Comedy", "Family"]
}
```

Connect with `mongosh`:

```bash
docker exec -it movies-mongo mongosh -u admin -p admin123 --authenticationDatabase admin movies
```

or from the host: `mongodb://admin:admin123@localhost:27017/movies?authSource=admin`.

### Embeddings

`embed_movies.py` builds one text per movie and embeds it with Ollama (`POST http://localhost:11434/api/embed`, model `embeddinggemma-2:270m`, 768 dimensions):

```
Title: ...
Genres: ...
Director: ...
Cast: ...
Overview: ...
```

Output is `movies_embeddings.jsonl`, one JSON object per line: `{"id": 862, "embedding": [768 floats]}`.

```bash
ollama pull embeddinggemma-2:270m          # once
python3 -I embed_movies.py                 # all movies (~30 min), batches of 32
python3 -I embed_movies.py --limit 64      # quick test
```

The script is resumable: ids already in the output file are skipped. The repository's `movies_embeddings.jsonl` already contains all 41,672 movies, so you only need to run this if you change the dataset or the text template.

### ChromaDB

- Collection `movies`, cosine distance, 41,672 items.
- Item id = the movie `id` as a string; document = the overview; metadata = `title`, `year`, `director`, `genres`.
- Loaded by `load_chroma.py` (runs in the `chroma-seed` container, using `chromadb-client==1.4.1` against the `chromadb/chroma:latest` server, currently 1.4.4).
- To reload after regenerating embeddings, delete the collection (or `docker compose down -v`) and run `docker compose up -d chroma-seed`.

## Web app

Server-rendered Express + EJS, `mongodb` driver and `chromadb` JS client.

| Route              | Description                                                                                                  |
|--------------------|--------------------------------------------------------------------------------------------------------------|
| `GET /`            | 24 random movies (with a Shuffle link). With `?q=` and/or `?genre=` it shows sorted, paginated results (`?page=`). |
| `GET /movie/:id`   | Movie details plus a **Similar movies** section with the 12 nearest movies. 404 page for unknown ids.        |
| `GET /healthz`     | Liveness check, returns `ok`.                                                                                |

**How "Similar movies" works:** the app reads the movie's stored embedding from Chroma (`get` by id), queries Chroma for the 13 nearest neighbors, drops the movie itself, keeps 12, then loads those movies from MongoDB to render poster/year/genres in similarity order. No Ollama call is needed at runtime. If Chroma is unreachable, the detail page still renders with a "Similar movies are currently unavailable" note.

Configuration (environment variables on the `web` service):

| Variable     | Default (local)                                                  | In Compose                                                  |
|--------------|------------------------------------------------------------------|-------------------------------------------------------------|
| `MONGO_URL`  | `mongodb://admin:admin123@localhost:27017/movies?authSource=admin` | `mongodb://admin:admin123@mongo:27017/movies?authSource=admin` |
| `CHROMA_URL` | `http://localhost:8000`                                          | `http://chroma:8000`                                        |
| `PORT`       | `3000`                                                           | `3000`                                                      |

Tunable constants are at the top of `app/server.js`: `PAGE_SIZE` (24) and `SIMILAR_COUNT` (12).

### Running the app without Docker

With MongoDB and Chroma up (`docker compose up -d mongo mongo-seed chroma chroma-seed`):

```bash
cd app
npm install
npm start        # http://localhost:3000
```

After changing app code in Docker: `docker compose up -d --build web`.

## Useful commands

```bash
# Document count in Mongo
docker exec movies-mongo mongosh -u admin -p admin123 --authenticationDatabase admin movies \
  --quiet --eval 'db.movies.countDocuments()'

# Chroma heartbeat / collection count
curl localhost:8000/api/v2/heartbeat
curl localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections

# Logs
docker compose logs -f web
docker compose logs mongo-seed chroma-seed
```

## Troubleshooting

- **`failed to connect to the docker API`**: Docker Desktop isn't running; start it and retry.
- **`chromadb/chroma:<version>` not found**: Chroma's Docker tags don't match its CLI version, so the compose file uses `latest`. If `latest` moves to a much newer server, bump `chromadb-client` in the `chroma-seed` command (and `chromadb` in `app/package.json`) to match.
- **Seed job says "already has N documents, skipping"**: expected on re-runs. Use `docker compose down -v` to reload from scratch.
- **Embedding script connection refused**: Ollama isn't running (`ollama serve`) or the model isn't pulled.
- **Similar movies unavailable**: check `docker compose ps chroma` and `docker compose logs web`.
- **Missing posters**: posters are hotlinked from `image.tmdb.org`, so they need internet access; a placeholder is shown when one fails to load.

## Security note

The credentials (`admin` / `admin123`) are hardcoded for local development only, and MongoDB (27017) and Chroma (8000) are published on the host without further protection. Don't expose this stack to a network as-is; move the credentials to a `.env` file and drop the published ports before deploying anywhere.

## Git note

Large files are excluded by `.gitignore`:

- `movies_embeddings.jsonl` (~412 MB) and `embed.log`
- everything in `movies_archive/` **except** `movies_summary.csv` (~23 MB, which Compose needs)
- `node_modules/` and `.DS_Store`

Because `movies_embeddings.jsonl` is not in the repository, a fresh clone must generate it before ChromaDB can be loaded:

```bash
ollama pull embeddinggemma-2:270m
python3 -I embed_movies.py        # ~30 minutes, writes movies_embeddings.jsonl
docker compose up -d --build
```

Without that file, the `chroma-seed` job fails, and the app's "Similar movies" section will be empty or show as unavailable. MongoDB and the rest of the catalog still work. If you would rather share the embeddings through the repository, track `movies_embeddings.jsonl` with Git LFS instead of ignoring it.
