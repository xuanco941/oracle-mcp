# Oracle MCP Server (read-only)

MCP server cho Oracle Database, chỉ cho phép truy vấn `SELECT`.

## Yêu cầu

- Node.js >= 18
- Oracle Instant Client (cần cho driver `oracledb` trên Windows/Linux)
- Tài khoản Oracle có quyền `SELECT` trên các bảng cần dùng

## Cài đặt

```bash
cd oracle-mcp
npm install
```

Copy file cấu hình:

```bash
copy .env.example .env
```

Sửa `.env`:

```env
ORACLE_USER=your_username
ORACLE_PASSWORD=your_password
ORACLE_CONNECT_STRING=localhost:1521/XEPDB1
ORACLE_MAX_ROWS=100
```

## Chạy thử

```bash
npm start
```

## Cấu hình trong Cursor

Thêm vào MCP settings (`mcp.json`):

```json
{
  "mcpServers": {
    "oracle": {
      "command": "node",
      "args": ["C:/Users/xuanc/Desktop/work/pl_sql/oracle-mcp/index.js"],
      "env": {
        "ORACLE_USER": "your_username",
        "ORACLE_PASSWORD": "your_password",
        "ORACLE_CONNECT_STRING": "localhost:1521/XEPDB1",
        "ORACLE_MAX_ROWS": "100"
      }
    }
  }
}
```

## Tools

| Tool | Mô tả |
|------|--------|
| `oracle_query` | Chạy một câu `SELECT` (hỗ trợ bind params, `maxRows`) |
| `oracle_explain_plan` | Xem execution plan của câu `SELECT` |
| `oracle_list_tables` | Liệt kê bảng/view |
| `oracle_list_schemas` | Liệt kê schema có bảng/view |
| `oracle_describe_table` | Xem cấu trúc cột của bảng/view |
| `oracle_search_columns` | Tìm cột theo tên (pattern `%`) |
| `oracle_table_indexes` | Xem index của bảng |
| `oracle_table_constraints` | Xem PK/FK/UK của bảng |
| `oracle_table_row_count` | Ước lượng số dòng từ statistics |

## Bảo mật

- Chỉ chấp nhận câu lệnh bắt đầu bằng `SELECT`
- Chặn nhiều statement (`;`)
- Chặn các keyword ghi/xóa/sửa schema (`INSERT`, `UPDATE`, `DELETE`, `DROP`, ...)
- Giới hạn số dòng trả về (mặc định 100, tối đa 1000)

Nên cấp quyền Oracle ở DB chỉ `SELECT` cho user dùng MCP.

`oracle_explain_plan` cần user có bảng plan (chạy `utlxplan.sql` hoặc `@?/rdbms/admin/utlxplan.sql` một lần).
