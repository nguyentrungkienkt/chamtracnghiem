// Xuất kết quả: bảng điểm có cột SBD, tên file ảnh có SBD
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsv, imageName } from "../app/export.js";

const session = { name: "Thử" };
const row = (createdAt, sbd, code, total) => ({
  createdAt, sbd, code, parts: { p1: 1, p2: 0, p3: 0 }, total, status: "GRADED", warnings: [],
});

test("bảng điểm: có cột SBD, sắp theo thời gian chấm, trống nếu không đọc được SBD", () => {
  const csv = buildCsv(session, [row(2, "", "0203", 1.5), row(1, "12345678", "0101", 2)]);
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "STT;SBD;Mã đề;Điểm Phần I;Điểm Phần II;Điểm Phần III;Tổng;Trạng thái;Ghi chú");
  assert.equal(lines[1], "1;12345678;0101;1,00;0,00;0,00;2,00;Đã chấm;");
  assert.equal(lines[2], "2;;0203;1,00;0,00;0,00;1,50;Đã chấm;");
});

test("tên file ảnh: có SBD và mã đề; không có SBD thì chỉ có mã đề", () => {
  assert.equal(imageName(3, "12345678", "0203"), "bai-003-sbd-12345678-ma-0203.jpg");
  assert.equal(imageName(12, "", "0203"), "bai-012-ma-0203.jpg");
});
