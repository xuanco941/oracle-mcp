# Oracle MCP Server

MCP server cho Oracle Database. Server mặc định chỉ cho phép các tool đọc dữ liệu (`SELECT`), và có thêm tool `oracle_execute_program` để gọi procedure/function phục vụ truy xuất dữ liệu qua OUT params hoặc `SYS_REFCURSOR`.

## Yêu cầu

- Node.js >= 18
- Oracle Database account có quyền phù hợp
- Oracle Instant Client nếu cần chạy node-oracledb Thick mode

## Cài đặt

```bash
npm install
```

Copy file cấu hình:

```bash
copy .env.example .env
```

Cấu hình môi trường:

```env
ORACLE_USER=your_username
ORACLE_PASSWORD=your_password
ORACLE_CONNECT_STRING=localhost:1521/XEPDB1
ORACLE_MAX_ROWS=100
```

## Sửa lỗi NJS-100 với NCHAR/SYS_REFCURSOR

Nếu AI gọi procedure trả `SYS_REFCURSOR` và gặp lỗi kiểu:

```text
NJS-100: national character set id ... is not supported by node-oracledb in Thin mode
```

thì nguyên nhân là node-oracledb đang chạy Thin mode và database dùng national character set mà Thin mode không hỗ trợ. Bật Thick mode bằng Oracle Instant Client:

```env
NODE_ORACLEDB_DRIVER_MODE=thick
NODE_ORACLEDB_CLIENT_LIB_DIR=C:\oracle\instantclient_21_13
```

Trong MCP settings cũng thêm hai biến này vào `env`.

Tool `oracle_execute_program` không dùng SQL `CALL`; nó tạo anonymous PL/SQL block dạng `BEGIN pkg.proc(:p1, :out_cursor); END;` hoặc `BEGIN :__ret := pkg.fn(...); END;`, vì cách này bind `SYS_REFCURSOR` ổn định hơn với node-oracledb.

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
        "ORACLE_MAX_ROWS": "100",
        "NODE_ORACLEDB_DRIVER_MODE": "thick",
        "NODE_ORACLEDB_CLIENT_LIB_DIR": "C:/oracle/instantclient_21_13"
      }
    }
  }
}
```

Nếu database không có lỗi `NJS-100`, có thể bỏ hai biến `NODE_ORACLEDB_*` để dùng Thin mode mặc định.

## Tools

| Tool | Mô tả |
|------|-------|
| `oracle_query` | Chạy một câu `SELECT` có bind params và giới hạn dòng |
| `oracle_explain_plan` | Xem execution plan của câu `SELECT` |
| `oracle_list_tables` | Liệt kê table/view |
| `oracle_list_schemas` | Liệt kê schema có table/view |
| `oracle_describe_table` | Xem cấu trúc cột của table/view |
| `oracle_search_columns` | Tìm cột theo pattern |
| `oracle_table_indexes` | Xem index của table |
| `oracle_table_constraints` | Xem PK/FK/UK của table |
| `oracle_table_row_count` | Ước lượng số dòng từ optimizer statistics |
| `oracle_list_plsql` | Liệt kê PL/SQL objects |
| `oracle_list_package_subprograms` | Liệt kê procedure/function trong package |
| `oracle_get_source` | Lấy source PL/SQL từ `all_source` |
| `oracle_object_errors` | Xem lỗi compile PL/SQL |
| `oracle_execute_program` | Gọi procedure/function và đọc OUT params hoặc `SYS_REFCURSOR` |

## Ví dụ gọi procedure trả SYS_REFCURSOR

```json
{
  "name": "MY_PKG.GET_DATA",
  "kind": "PROCEDURE",
  "params": [
    { "name": "P_ID", "dir": "in", "type": "number", "value": 123 },
    { "name": "P_CURSOR", "dir": "out", "type": "cursor" }
  ],
  "maxRows": 100
}
```

## Bảo mật

- `oracle_query` chỉ chấp nhận statement bắt đầu bằng `SELECT`
- Chặn nhiều statement và keyword ghi/xóa/sửa schema
- Giới hạn số dòng trả về, mặc định 100 và tối đa 1000
- `oracle_execute_program` chạy `autoCommit: false` và luôn rollback sau khi gọi

Nên dùng Oracle user chỉ có quyền đọc dữ liệu cho MCP.
