import csv
import json
import time

import chromadb

BATCH = 1000

client = None
for _ in range(30):
    try:
        client = chromadb.HttpClient(host="chroma", port=8000)
        client.heartbeat()
        break
    except Exception:
        time.sleep(2)
else:
    raise SystemExit("chroma not reachable")

# cosine distance suits text embeddings
col = client.get_or_create_collection("movies", metadata={"hnsw:space": "cosine"})

with open("/data/movies_summary.csv", newline="", encoding="utf-8") as f:
    info = {r["id"]: r for r in csv.DictReader(f)}

existing = col.count()
total = sum(1 for _ in open("/data/movies_embeddings.jsonl", encoding="utf-8"))
if existing >= total:
    print(f"collection already has {existing} items, skipping load")
    raise SystemExit(0)

ids, embs, metas, docs = [], [], [], []


def flush():
    if ids:
        col.upsert(ids=ids, embeddings=embs, metadatas=metas, documents=docs)
        print(f"{col.count()}/{total}", flush=True)
        ids.clear(), embs.clear(), metas.clear(), docs.clear()


with open("/data/movies_embeddings.jsonl", encoding="utf-8") as f:
    for line in f:
        d = json.loads(line)
        row = info[str(d["id"])]
        ids.append(str(d["id"]))
        embs.append(d["embedding"])
        docs.append(row["overview"])
        meta = {"title": row["title"], "director": row["director"], "genres": row["genres"]}
        if row["year"]:
            meta["year"] = int(row["year"])
        metas.append(meta)
        if len(ids) >= BATCH:
            flush()
flush()
print("done:", col.count())
