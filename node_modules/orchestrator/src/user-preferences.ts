import type Database from "better-sqlite3";

export type UserPreferences = {
  subjectId: string;
  persistProfile: boolean;
  darkMode: boolean;
  updatedAt: number;
};

export type UserPreferencesStore = {
  get(subjectId: string): UserPreferences;
  setPersistProfile(subjectId: string, persistProfile: boolean): UserPreferences;
  setDarkMode(subjectId: string, darkMode: boolean): UserPreferences;
};

type PrefsRow = {
  subject_id: string;
  persist_profile: number;
  dark_mode: number;
  updated_at: number;
};

export function createUserPreferencesStore(db: Database.Database): UserPreferencesStore {
  const select = db.prepare<[string], PrefsRow>(
    `SELECT subject_id, persist_profile, dark_mode, updated_at FROM user_preferences WHERE subject_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO user_preferences (subject_id, persist_profile, dark_mode, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(subject_id) DO UPDATE SET
       persist_profile = excluded.persist_profile,
       dark_mode = excluded.dark_mode,
       updated_at = excluded.updated_at`,
  );

  function rowToPrefs(row: PrefsRow): UserPreferences {
    return {
      subjectId: row.subject_id,
      persistProfile: Boolean(row.persist_profile),
      darkMode: Boolean(row.dark_mode),
      updatedAt: row.updated_at,
    };
  }

  function defaults(subjectId: string): UserPreferences {
    return { subjectId, persistProfile: false, darkMode: false, updatedAt: 0 };
  }

  function write(next: UserPreferences): UserPreferences {
    upsert.run(
      next.subjectId,
      next.persistProfile ? 1 : 0,
      next.darkMode ? 1 : 0,
      next.updatedAt,
    );
    return next;
  }

  function get(subjectId: string): UserPreferences {
    const row = select.get(subjectId);
    if (!row) return defaults(subjectId);
    return rowToPrefs(row);
  }

  return {
    get,

    setPersistProfile(subjectId, persistProfile) {
      const current = get(subjectId);
      return write({
        subjectId,
        persistProfile,
        darkMode: current.darkMode,
        updatedAt: Date.now(),
      });
    },

    setDarkMode(subjectId, darkMode) {
      const current = get(subjectId);
      return write({
        subjectId,
        persistProfile: current.persistProfile,
        darkMode,
        updatedAt: Date.now(),
      });
    },
  };
}
