import oracledb from "oracledb";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|merge|drop|truncate|alter|create|grant|revoke|exec|execute|call|commit|rollback)\b/i;

const DEFAULT_MAX_ROWS = 100;
const MAX_ALLOWED_ROWS = 1000;

function getMaxRows() {
  const value = Number.parseInt(process.env.ORACLE_MAX_ROWS ?? "", 10);
  if (Number.isNaN(value) || value <= 0) {
    return DEFAULT_MAX_ROWS;
  }
  return Math.min(value, MAX_ALLOWED_ROWS);
}

function validateSelectOnly(sql) {
  const text = sql.trim();

  if (!text) {
    return "SQL query cannot be empty.";
  }

  if (text.includes(";")) {
    return "Multiple statements are not allowed.";
  }

  if (!/^\s*select\b/i.test(text)) {
    return "Only SELECT queries are allowed.";
  }

  if (FORBIDDEN_KEYWORDS.test(text)) {
    return "Query contains forbidden keywords. Only SELECT is allowed.";
  }

  return null;
}

async function getConnection() {
  const user = process.env.ORACLE_USER;
  const password = process.env.ORACLE_PASSWORD;
  const connectString = process.env.ORACLE_CONNECT_STRING;

  if (!user || !password || !connectString) {
    throw new Error(
      "Missing Oracle credentials. Set ORACLE_USER, ORACLE_PASSWORD, and ORACLE_CONNECT_STRING."
    );
  }

  return oracledb.getConnection({ user, password, connectString });
}

function textResult(message) {
  return {
    content: [{ type: "text", text: message }],
  };
}

function jsonResult(data) {
  return textResult(JSON.stringify(data, null, 2));
}

function resolveMaxRows(requested) {
  if (requested === undefined) {
    return getMaxRows();
  }
  return Math.min(Math.max(requested, 1), MAX_ALLOWED_ROWS);
}

async function withConnection(fn) {
  let conn;

  try {
    conn = await getConnection();
    return await fn(conn);
  } catch (err) {
    return textResult(`Oracle error: ${err.message}`);
  } finally {
    if (conn) {
      await conn.close();
    }
  }
}

const server = new McpServer({
  name: "oracle-mcp",
  version: "1.0.0",
});

server.registerTool(
  "oracle_query",
  {
    description: "Run a read-only SELECT query against Oracle Database.",
    inputSchema: {
      sql: z.string().describe("A single SELECT statement."),
      binds: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Optional bind parameters, e.g. { id: 1, name: 'ABC' }."),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(MAX_ALLOWED_ROWS)
        .optional()
        .describe(
          `Maximum rows to return (default ${DEFAULT_MAX_ROWS}, max ${MAX_ALLOWED_ROWS}).`
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sql, binds, maxRows }) => {
    const validationError = validateSelectOnly(sql);
    if (validationError) {
      return textResult(validationError);
    }

    return withConnection(async (conn) => {
      const result = await conn.execute(sql, binds ?? [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        maxRows: resolveMaxRows(maxRows),
      });

      return jsonResult({
        rowCount: result.rows?.length ?? 0,
        rows: result.rows ?? [],
      });
    });
  }
);

server.registerTool(
  "oracle_list_tables",
  {
    description: "List tables and views accessible to the current Oracle user.",
    inputSchema: {
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name. Defaults to current user."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of objects to return (default 100)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ owner, limit = 100 }) =>
    withConnection(async (conn) => {
      const sql = `
        SELECT owner, object_name, object_type
        FROM all_objects
        WHERE object_type IN ('TABLE', 'VIEW')
          AND (:owner IS NULL OR owner = UPPER(:owner))
        ORDER BY owner, object_name
        FETCH FIRST :limit ROWS ONLY
      `;

      const result = await conn.execute(
        sql,
        { owner: owner?.toUpperCase() ?? null, limit },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_describe_table",
  {
    description: "Describe columns of a table or view.",
    inputSchema: {
      table: z.string().describe("Table or view name."),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name. Defaults to current user."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ table, owner }) =>
    withConnection(async (conn) => {
      const sql = `
        SELECT column_id, column_name, data_type, data_length, nullable
        FROM all_tab_columns
        WHERE table_name = UPPER(:table)
          AND (:owner IS NULL OR owner = UPPER(:owner))
        ORDER BY column_id
      `;

      const result = await conn.execute(
        sql,
        {
          table,
          owner: owner?.toUpperCase() ?? null,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_explain_plan",
  {
    description: "Show execution plan for a read-only SELECT query.",
    inputSchema: {
      sql: z.string().describe("A single SELECT statement."),
      binds: z
        .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Optional bind parameters used by the SELECT."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sql, binds }) => {
    const validationError = validateSelectOnly(sql);
    if (validationError) {
      return textResult(validationError);
    }

    const statementId = `mcp_${Date.now()}`;

    return withConnection(async (conn) => {
      await conn.execute(
        `EXPLAIN PLAN SET STATEMENT_ID = :mcpStatementId FOR ${sql}`,
        {
          mcpStatementId: statementId,
          ...(binds ?? {}),
        }
      );

      const result = await conn.execute(
        `SELECT plan_table_output AS line
         FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, :mcpStatementId, 'ALL'))`,
        { mcpStatementId: statementId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const plan = (result.rows ?? [])
        .map((row) => row.LINE ?? row.line)
        .join("\n");

      return jsonResult({ statementId, plan });
    });
  }
);

server.registerTool(
  "oracle_list_schemas",
  {
    description:
      "List schemas (owners) that contain tables or views accessible to the current user.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of schemas to return (default 100)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ limit = 100 }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT owner, COUNT(*) AS object_count
         FROM all_objects
         WHERE object_type IN ('TABLE', 'VIEW')
         GROUP BY owner
         ORDER BY owner
         FETCH FIRST :limit ROWS ONLY`,
        { limit },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_search_columns",
  {
    description: "Search columns by name pattern across accessible tables and views.",
    inputSchema: {
      pattern: z
        .string()
        .describe("Column name pattern. Use % as wildcard, e.g. %ID or MA%.%"),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of matches to return (default 100)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ pattern, owner, limit = 100 }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT owner, table_name, column_name, data_type, nullable
         FROM all_tab_columns
         WHERE column_name LIKE UPPER(:pattern)
           AND (:owner IS NULL OR owner = UPPER(:owner))
         ORDER BY owner, table_name, column_id
         FETCH FIRST :limit ROWS ONLY`,
        {
          pattern,
          owner: owner?.toUpperCase() ?? null,
          limit,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_table_indexes",
  {
    description: "List indexes on a table or view.",
    inputSchema: {
      table: z.string().describe("Table or view name."),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ table, owner }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT i.owner,
                i.index_name,
                i.uniqueness,
                i.status,
                ic.column_name,
                ic.column_position
         FROM all_indexes i
         JOIN all_ind_columns ic
           ON i.owner = ic.index_owner
          AND i.index_name = ic.index_name
         WHERE i.table_name = UPPER(:table)
           AND (:owner IS NULL OR i.table_owner = UPPER(:owner))
         ORDER BY i.index_name, ic.column_position`,
        {
          table,
          owner: owner?.toUpperCase() ?? null,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_table_constraints",
  {
    description: "List primary key, foreign key, and unique constraints on a table.",
    inputSchema: {
      table: z.string().describe("Table name."),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ table, owner }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT c.owner,
                c.constraint_name,
                c.constraint_type,
                c.status,
                cc.column_name,
                cc.position,
                r.owner AS referenced_owner,
                r.table_name AS referenced_table,
                rc.column_name AS referenced_column
         FROM all_constraints c
         JOIN all_cons_columns cc
           ON c.owner = cc.owner
          AND c.constraint_name = cc.constraint_name
         LEFT JOIN all_constraints r
           ON c.r_owner = r.owner
          AND c.r_constraint_name = r.constraint_name
         LEFT JOIN all_cons_columns rc
           ON r.owner = rc.owner
          AND r.constraint_name = rc.constraint_name
          AND cc.position = rc.position
         WHERE c.table_name = UPPER(:table)
           AND (:owner IS NULL OR c.owner = UPPER(:owner))
         ORDER BY c.constraint_name, cc.position`,
        {
          table,
          owner: owner?.toUpperCase() ?? null,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_table_row_count",
  {
    description: "Estimate row count for a table using Oracle optimizer statistics.",
    inputSchema: {
      table: z.string().describe("Table name."),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ table, owner }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT owner, table_name, num_rows, last_analyzed, blocks, avg_row_len
         FROM all_tables
         WHERE table_name = UPPER(:table)
           AND (:owner IS NULL OR owner = UPPER(:owner))`,
        {
          table,
          owner: owner?.toUpperCase() ?? null,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_list_plsql",
  {
    description:
      "List PL/SQL objects (procedure, function, package, package body, trigger, type) accessible to the current user.",
    inputSchema: {
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name. Defaults to current user."),
      objectType: z
        .enum([
          "PROCEDURE",
          "FUNCTION",
          "PACKAGE",
          "PACKAGE BODY",
          "TRIGGER",
          "TYPE",
          "TYPE BODY",
        ])
        .optional()
        .describe("Filter by object type."),
      namePattern: z
        .string()
        .optional()
        .describe("Optional object name pattern with % wildcard, e.g. CALC%."),
      status: z
        .enum(["VALID", "INVALID", "ALL"])
        .optional()
        .describe("Filter by object status (default ALL)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of objects to return (default 100)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ owner, objectType, namePattern, status = "ALL", limit = 100 }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT owner,
                object_type,
                object_name,
                status,
                TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI:SS') AS last_ddl_time
         FROM all_objects
         WHERE object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')
           AND (:owner IS NULL OR owner = UPPER(:owner))
           AND (:objectType IS NULL OR object_type = :objectType)
           AND (:namePattern IS NULL OR object_name LIKE UPPER(:namePattern))
           AND (:status = 'ALL' OR status = :status)
         ORDER BY owner, object_type, object_name
         FETCH FIRST :limit ROWS ONLY`,
        {
          owner: owner?.toUpperCase() ?? null,
          objectType: objectType ?? null,
          namePattern: namePattern ? namePattern.toUpperCase() : null,
          status,
          limit,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_list_triggers",
  {
    description: "List triggers defined on a specific table.",
    inputSchema: {
      table: z.string().describe("Table name."),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name. Defaults to current user."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ table, owner }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT t.owner,
                t.trigger_name,
                t.trigger_type,
                t.triggering_event,
                t.status,
                DBMS_LOB.SUBSTR(t.trigger_body, 4000, 1) AS trigger_body
         FROM all_triggers t
         WHERE t.table_name = UPPER(:table)
           AND (:owner IS NULL OR t.table_owner = UPPER(:owner))
         ORDER BY t.trigger_name`,
        {
          table,
          owner: owner?.toUpperCase() ?? null,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_list_package_subprograms",
  {
    description:
      "List procedures and functions defined inside a package (spec and/or body).",
    inputSchema: {
      package: z.string().describe("Package name."),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name. Defaults to current user."),
      subobjectType: z
        .enum(["PACKAGE", "PACKAGE BODY", "ALL"])
        .optional()
        .describe("Limit to spec, body, or both (default ALL)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({
    package: pkg,
    owner,
    subobjectType = "ALL",
  }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT owner,
                object_type,
                procedure_name AS subprogram_name,
                overload,
                subprogram_id
         FROM all_procedures
         WHERE object_name = UPPER(:pkg)
           AND (:owner IS NULL OR owner = UPPER(:owner))
           AND (:subobjectType = 'ALL' OR object_type = :subobjectType)
           AND (procedure_name IS NULL OR procedure_name <> object_name)
         ORDER BY object_type, subprogram_id, procedure_name`,
        {
          pkg,
          owner: owner?.toUpperCase() ?? null,
          subobjectType,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_object_errors",
  {
    description:
      "Show PL/SQL compilation errors for invalid objects (from all_errors).",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          "Optional object name. If omitted, list errors for all invalid objects."
        ),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name."),
      type: z
        .string()
        .optional()
        .describe(
          "Optional object type, e.g. PACKAGE BODY, TRIGGER, VIEW."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of error rows to return (default 100)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ name, owner, type, limit = 100 }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT owner,
                name,
                type,
                sequence# AS sequence_no,
                line,
                position,
                attribute,
                message_text,
                TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') AS created
         FROM all_errors
         WHERE (:name IS NULL OR name = UPPER(:name))
           AND (:owner IS NULL OR owner = UPPER(:owner))
           AND (:type IS NULL OR type = UPPER(:type))
         ORDER BY owner, name, type, sequence#
         FETCH FIRST :limit ROWS ONLY`,
        {
          name: name ? name.toUpperCase() : null,
          owner: owner?.toUpperCase() ?? null,
          type: type ? type.toUpperCase() : null,
          limit,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return jsonResult(result.rows ?? []);
    })
);

server.registerTool(
  "oracle_get_source",
  {
    description:
      "Get PL/SQL source code of a stored object (procedure, function, package, package body, trigger, type) from all_source.",
    inputSchema: {
      name: z.string().describe("Object name."),
      type: z
        .enum([
          "PROCEDURE",
          "FUNCTION",
          "PACKAGE",
          "PACKAGE BODY",
          "TRIGGER",
          "TYPE",
          "TYPE BODY",
        ])
        .describe("Object type."),
      owner: z
        .string()
        .optional()
        .describe("Optional schema/owner name. Defaults to current user."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ name, type, owner }) =>
    withConnection(async (conn) => {
      const result = await conn.execute(
        `SELECT line, text
         FROM all_source
         WHERE name = UPPER(:name)
           AND type = :type
           AND (:owner IS NULL OR owner = UPPER(:owner))
         ORDER BY line`,
        {
          name,
          type,
          owner: owner?.toUpperCase() ?? null,
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { TEXT: { type: oracledb.STRING } } }
      );

      const source = (result.rows ?? [])
        .map((row) => row.TEXT ?? row.text ?? "")
        .join("");

      return jsonResult({
        name,
        type,
        owner: owner?.toUpperCase() ?? null,
        lineCount: result.rows?.length ?? 0,
        source,
      });
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
