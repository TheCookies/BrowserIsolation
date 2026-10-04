import type Database from "better-sqlite3";

export type UserPreferences = {
  subjectId: string;
  persistProfile: boolean;
  updatedAt: number;
};

export type UserPreferencesStore = {
  get(subjectId: string): UserPreferences;
  setPersistProfile(subjectId: string, persistProfile: boolean): UserPreferences;
};

export function createUserPreferencesStore(db: Database.Database): UserPreferencesStore {
  const select = db.prepare<[string], { subject_id: string; persist_profile: number; updated_at: number }>(
    `SELECT subject_id, persist_profile, updated_at FROM user_preferences WHERE subject_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO user_preferences (subject_id, persist_profile, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(subject_id) DO UPDATE SET
       persist_profile = excluded.persist_profile,
       updated_at = excluded.updated_at`,
  );

  function rowToPrefs(row: {
    subject_id: string;
    persist_profile: number;
    updated_at: number;
  }): UserPreferences {
    return {
      subjectId: row.subject_id,
      persistProfile: Boolean(row.persist_profile),
      updatedAt: row.updated_at,
    };
  }

  return {
    get(subjectId) {
      const row = select.get(subjectId);
      if (!row) {
        return { subjectId, persistProfile: false, updatedAt: 0 };
      }
      return rowToPrefs(row);
    },

    setPersistProfile(subjectId, persistProfile) {
      const updatedAt = Date.now();
      upsert.run(subjectId, persistProfile ? 1 : 0, updatedAt);
      return { subjectId, persistProfile, updatedAt };
    },
  };
}
