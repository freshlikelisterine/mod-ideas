ALTER TABLE ideas ADD COLUMN comments INTEGER NOT NULL DEFAULT 0;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX comments_idea ON comments (idea_id, created);
