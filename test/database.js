export function database(sqlite) {
  function prepare(sql, values = []) {
    const args = Object.fromEntries(values.map((v, i) => [String(i + 1), v]));
    const all = () => sqlite.prepare(sql).all(args);
    const execute = () => {
      const s = sqlite.prepare(sql);
      const rows = s.columns().length ? s.all(args) : [];
      const result = rows.length
        ? { changes: sqlite.prepare("SELECT changes() AS n").get().n }
        : s.columns().length
          ? { changes: 0 }
          : s.run(args);
      return {
        success: true,
        results: rows,
        meta: { changes: Number(result.changes) },
      };
    };
    return {
      bind: (...v) => prepare(sql, v),
      first: async () => all()[0] ?? null,
      all: async () => ({ results: all() }),
      run: async () => execute(),
      execute,
    };
  }
  return {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
