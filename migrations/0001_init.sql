CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  author TEXT NOT NULL,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE votes (
  idea_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  v INTEGER NOT NULL,
  PRIMARY KEY (idea_id, voter)
);
CREATE INDEX votes_voter ON votes (voter);

CREATE TABLE hits (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset INTEGER NOT NULL
);
