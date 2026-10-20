import { describe, expect, it } from "vitest";
import { changedValues, normalizeFields, type PdfJsField } from "./formFields";

const objects: Record<string, PdfJsField[]> = {
  city: [{ name: "city", type: "text", value: "", page: 1, rect: [72, 700, 300, 722] }],
  name: [
    {
      name: "name",
      type: "text",
      value: "Asha",
      page: 0,
      rect: [72, 740, 300, 762],
      charLimit: 40,
    },
  ],
  notes: [
    { name: "notes", type: "text", value: "", page: 0, rect: [72, 640, 300, 720], multiline: true },
  ],
  agree: [
    {
      name: "agree",
      type: "checkbox",
      value: "Off",
      exportValues: "Yes",
      page: 0,
      rect: [72, 600, 88, 616],
    },
  ],
  size: [
    { name: "size" }, // parent entry without a type
    {
      name: "size",
      type: "radiobutton",
      value: "small",
      exportValues: "small",
      page: 0,
      rect: [72, 560, 88, 576],
    },
    {
      name: "size",
      type: "radiobutton",
      value: "small",
      exportValues: "large",
      page: 0,
      rect: [120, 560, 136, 576],
    },
  ],
  country: [
    {
      name: "country",
      type: "combobox",
      value: "India",
      page: 0,
      rect: [72, 500, 272, 522],
      items: [
        { exportValue: "India", displayValue: "India" },
        { exportValue: "JP", displayValue: "Japan" },
      ],
    },
  ],
  pin: [{ name: "pin", type: "text", password: true, page: 0, rect: [0, 0, 1, 1] }],
  submit: [{ name: "submit", type: "button", page: 0, rect: [0, 0, 1, 1] }],
  sig: [{ name: "sig", type: "signature", page: 0, rect: [0, 0, 1, 1] }],
  locked: [
    { name: "locked", type: "text", value: "x", editable: false, page: 1, rect: [0, 100, 1, 120] },
  ],
};

describe("normalizeFields", () => {
  const fields = normalizeFields(objects);

  it("keeps fillable fields in reading order", () => {
    expect(fields.map((f) => f.name)).toEqual([
      "name",
      "notes",
      "agree",
      "size",
      "country",
      "city",
      "locked",
    ]);
  });

  it("reads kinds, values and options", () => {
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.name).toMatchObject({ kind: "text", value: "Asha", maxLength: 40 });
    expect(byName.notes?.multiline).toBe(true);
    expect(byName.agree).toMatchObject({ kind: "checkbox", value: false });
    expect(byName.size).toMatchObject({ kind: "radio", value: "small" });
    expect(byName.size?.options.map((o) => o.value)).toEqual(["small", "large"]);
    expect(byName.country?.options).toEqual([
      { value: "India", label: "India" },
      { value: "JP", label: "Japan" },
    ]);
    expect(byName.locked?.readOnly).toBe(true);
  });

  it("sends only what changed", () => {
    expect(
      changedValues(fields, { name: "Asha", agree: true, size: "large", locked: "y", city: "" }),
    ).toEqual({ agree: true, size: "large" });
  });
});
