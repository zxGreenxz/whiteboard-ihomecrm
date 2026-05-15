import { describe, it, expect } from "vitest";
import {
  parseJobQuickInput,
  type BuildingRef,
  type RoomRef,
  type JobTypeRef,
} from "../jobQuickInput";

const today = new Date(2026, 4, 15); // 2026-05-15 (month is 0-indexed)

const buildings: BuildingRef[] = [
  { id: "b-1", name: "1392QT", code: "1392qt" },
  { id: "b-2", name: "Tòa A", code: "TA" },
];

const rooms: RoomRef[] = [
  { id: "r-1", name: "201", code: "201", building_id: "b-1" },
  { id: "r-2", name: "202", code: "202", building_id: "b-1" },
  { id: "r-3", name: "A101", code: "A101", building_id: "b-2" },
];

const jobTypes: JobTypeRef[] = [
  { id: "t-1", name: "sửa" },
  { id: "t-2", name: "Vệ sinh" },
];

describe("parseJobQuickInput", () => {
  it("parses example 1: no date → defaults to tomorrow end-of-day", () => {
    const r = parseJobQuickInput(
      "201 1392qt sửa vòi nước",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.buildingId).toBe("b-1");
    expect(r.roomId).toBe("r-1");
    expect(r.jobTypeId).toBe("t-1");
    expect(r.descriptionText).toBe("vòi nước");
    expect(r.deadlineSource).toBe("default-tomorrow");
    expect(r.deadline.getDate()).toBe(16);
    expect(r.deadline.getMonth()).toBe(4);
    expect(r.deadline.getHours()).toBe(23);
    expect(r.hasAnyError).toBe(false);
  });

  it("parses example 2: trailing offset '2' → 2 days from today", () => {
    const r = parseJobQuickInput(
      "201 1392qt sửa vòi nước 2",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.descriptionText).toBe("vòi nước");
    expect(r.deadlineSource).toBe("offset");
    expect(r.deadline.getDate()).toBe(17);
    expect(r.deadline.getMonth()).toBe(4);
  });

  it("parses trailing offset '0' as today end-of-day", () => {
    const r = parseJobQuickInput(
      "201 1392qt sửa vòi 0",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.deadlineSource).toBe("offset");
    expect(r.deadline.getDate()).toBe(15);
    expect(r.deadline.getMonth()).toBe(4);
    expect(r.deadline.getHours()).toBe(23);
  });

  it("parses dd/m date", () => {
    const r = parseJobQuickInput(
      "201 1392qt sửa vòi 17/5",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.deadlineSource).toBe("date");
    expect(r.deadline.getDate()).toBe(17);
    expect(r.deadline.getMonth()).toBe(4);
    expect(r.deadline.getFullYear()).toBe(2026);
  });

  it("parses dd/mm date with leading zero", () => {
    const r = parseJobQuickInput(
      "201 1392qt sửa vòi 17/05",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.deadlineSource).toBe("date");
    expect(r.deadline.getDate()).toBe(17);
    expect(r.deadline.getMonth()).toBe(4);
  });

  it("flags structure error when fewer than 4 tokens", () => {
    const r = parseJobQuickInput(
      "201 1392qt sửa",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.errors.structure).toBeTruthy();
    expect(r.hasAnyError).toBe(true);
  });

  it("flags structure error when only 3 head tokens + trailing date", () => {
    const r = parseJobQuickInput(
      "201 1392qt sửa 2",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.errors.structure).toBeTruthy();
  });

  it("flags buildingNotFound when token doesn't match any building", () => {
    const r = parseJobQuickInput(
      "201 xxxx sửa vòi nước",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.buildingId).toBeNull();
    expect(r.roomId).toBeNull();
    expect(r.errors.buildingNotFound).toBeTruthy();
  });

  it("flags roomNotFound when room is not in building", () => {
    const r = parseJobQuickInput(
      "999 1392qt sửa vòi nước",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.buildingId).toBe("b-1");
    expect(r.roomId).toBeNull();
    expect(r.errors.roomNotFound).toBeTruthy();
  });

  it("flags jobTypeNotFound when type name doesn't match", () => {
    const r = parseJobQuickInput(
      "201 1392qt thaymới vòi nước",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.jobTypeId).toBeNull();
    expect(r.errors.jobTypeNotFound).toContain("thaymới");
  });

  it("matches building and room case-insensitively", () => {
    const r = parseJobQuickInput(
      "201 1392QT Sửa vòi",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.buildingId).toBe("b-1");
    expect(r.roomId).toBe("r-1");
    expect(r.jobTypeId).toBe("t-1");
  });

  it("collapses multiple spaces between tokens", () => {
    const r = parseJobQuickInput(
      "  201   1392qt  sửa   vòi nước  ",
      today,
      buildings,
      rooms,
      jobTypes,
    );
    expect(r.buildingId).toBe("b-1");
    expect(r.descriptionText).toBe("vòi nước");
  });
});
