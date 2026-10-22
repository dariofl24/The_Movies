#!/usr/bin/env python3
"""Embed every movie in movies_summary.csv with Ollama and write JSONL: {"id": ..., "embedding": [...]}.

Resumable: ids already present in the output file are skipped.
Usage: python3 embed_movies.py [--limit N] [--batch 32]
"""
import argparse
import csv
import json
import os
import urllib.request

CSV_PATH = "movies_archive/movies_summary.csv"
OUT_PATH = "movies_embeddings.jsonl"
URL = "http://localhost:11434/api/embed"
MODEL = "embeddinggemma-2:270m"


def movie_text(row):
    parts = [
        f"Title: {row['title']}",
        f"Genres: {row['genres']}" if row["genres"] else "",
        f"Director: {row['director']}" if row["director"] else "",
        f"Cast: {row['cast']}" if row["cast"] else "",
        f"Overview: {row['overview']}" if row["overview"] else "",
    ]
    return "\n".join(p for p in parts if p)


def embed(texts):
    req = urllib.request.Request(
        URL,
        data=json.dumps({"model": MODEL, "input": texts}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.load(resp)["embeddings"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--batch", type=int, default=32)
    args = ap.parse_args()

    done = set()
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as f:
            done = {json.loads(line)["id"] for line in f if line.strip()}

    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if int(r["id"]) not in done]
    if args.limit:
        rows = rows[: args.limit]
    print(f"{len(done)} already done, {len(rows)} to embed")

    with open(OUT_PATH, "a", encoding="utf-8") as out:
        for i in range(0, len(rows), args.batch):
            chunk = rows[i : i + args.batch]
            vectors = embed([movie_text(r) for r in chunk])
            for r, v in zip(chunk, vectors):
                out.write(json.dumps({"id": int(r["id"]), "embedding": v}) + "\n")
            out.flush()
            print(f"{min(i + args.batch, len(rows))}/{len(rows)}", flush=True)


if __name__ == "__main__":
    main()
