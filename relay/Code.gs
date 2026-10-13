/**
 * Relay Drive cho ứng dụng chấm trắc nghiệm.
 *
 * Triển khai: Apps Script, chạy dưới tài khoản của người quản trị (Execute as: Me,
 * Who has access: Anyone). Script giữ quyền Drive; điện thoại và máy Windows chỉ
 * gọi tới địa chỉ web app, không giữ khóa hay token nào.
 *
 * Cấu hình (Project Settings → Script properties, KHÔNG ghi vào mã nguồn):
 *   ROOT_FOLDER_ID : ID thư mục gốc trên Drive chung.
 *   CODES          : JSON {"<mã truy cập>": "<tên người chấm>"}.
 *
 * Mã truy cập quyết định thư mục: người chấm không chọn tên thư mục, script
 * tra tên từ mã. Một mã chỉ thấy thư mục của đúng người đó.
 */

var MAX_NAME_LEN = 80;

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var person = authenticate_(req.code);
    if (!person) return json_({ ok: false, error: 'unauthorized' });

    var folder = personFolder_(person);

    switch (req.action) {
      case 'ping':
        return json_({ ok: true, person: person });
      case 'upload':
        return json_(uploadFile_(folder, req));
      case 'list':
        return json_(listFiles_(folder));
      case 'get':
        return json_(getFile_(folder, req.id));
      case 'delete':
        return json_(trashFile_(folder, req.id));
      default:
        return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'chamtracnghiem-relay' });
}

/* ---------- xác thực và thư mục ---------- */

function authenticate_(code) {
  if (!code || typeof code !== 'string') return null;
  var map = JSON.parse(PropertiesService.getScriptProperties().getProperty('CODES') || '{}');
  // Khớp đúng chuỗi; không tiết lộ mã nào tồn tại khi sai.
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : null;
}

function personFolder_(person) {
  var rootId = PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID');
  if (!rootId) throw new Error('ROOT_FOLDER_ID chưa được cấu hình');
  var root = DriveApp.getFolderById(rootId);
  var name = sanitize_(person);
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function sanitize_(name) {
  var s = String(name).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (!s) s = 'nguoi-cham';
  return s.substring(0, MAX_NAME_LEN);
}

/* ---------- thao tác file ---------- */

function uploadFile_(folder, req) {
  if (!req.name || !req.data) return { ok: false, error: 'thiếu name hoặc data' };
  var bytes = Utilities.base64Decode(req.data);
  var blob = Utilities.newBlob(bytes, req.mime || 'image/jpeg', sanitize_(req.name));
  var file = folder.createFile(blob);
  return { ok: true, id: file.getId(), name: file.getName() };
}

function listFiles_(folder) {
  var out = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    out.push({ id: f.getId(), name: f.getName(), size: f.getSize(), created: f.getDateCreated().getTime() });
  }
  out.sort(function (a, b) { return a.created - b.created; });
  return { ok: true, files: out };
}

function getFile_(folder, id) {
  var f = fileInFolder_(folder, id);
  if (!f) return { ok: false, error: 'không tìm thấy file' };
  return { ok: true, name: f.getName(), mime: f.getMimeType(), data: Utilities.base64Encode(f.getBlob().getBytes()) };
}

function trashFile_(folder, id) {
  var f = fileInFolder_(folder, id);
  if (!f) return { ok: false, error: 'không tìm thấy file' };
  f.setTrashed(true);
  return { ok: true };
}

// Chỉ thao tác trên file nằm trực tiếp trong thư mục của người gọi.
function fileInFolder_(folder, id) {
  if (!id) return null;
  var f;
  try { f = DriveApp.getFileById(id); } catch (err) { return null; }
  var parents = f.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) return f;
  }
  return null;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
