#!/usr/bin/env bash
set -euo pipefail

URI="mongodb://admin:admin123@mongo:27017/movies?authSource=admin"

count=$(mongosh "$URI" --quiet --eval 'db.movies.countDocuments()')
if [ "$count" -gt 0 ]; then
  echo "movies collection already has $count documents, skipping import"
  exit 0
fi

mongoimport --uri "$URI" --collection movies --type csv --headerline \
  --ignoreBlanks --file /data/movies_summary.csv

# Convert types and split the " | " separated lists into arrays
mongosh "$URI" --quiet --eval '
db.movies.updateMany({}, [{
  $set: {
    id: { $toInt: "$id" },
    year: { $convert: { input: "$year", to: "int", onError: null, onNull: null } },
    release_date: { $convert: { input: "$release_date", to: "date", onError: null, onNull: null } },
    cast:    { $cond: [{ $eq: [{ $type: "$cast" }, "string"] },    { $map: { input: { $split: ["$cast", " | "] },    as: "x", in: { $trim: { input: "$$x" } } } }, []] },
    country: { $cond: [{ $eq: [{ $type: "$country" }, "string"] }, { $map: { input: { $split: ["$country", " | "] }, as: "x", in: { $trim: { input: "$$x" } } } }, []] },
    genres:  { $cond: [{ $eq: [{ $type: "$genres" }, "string"] },  { $map: { input: { $split: ["$genres", " | "] },  as: "x", in: { $trim: { input: "$$x" } } } }, []] }
  }
}]);
db.movies.createIndex({ id: 1 }, { unique: true });
db.movies.createIndex({ title: "text", overview: "text" });
db.movies.createIndex({ genres: 1 });
db.movies.createIndex({ year: 1 });
print("movies loaded: " + db.movies.countDocuments());
'
