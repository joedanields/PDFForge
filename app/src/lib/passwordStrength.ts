/**
 * Offline password strength estimate for the Protect tool's meter (docs/02 F1). A heuristic,
 * not a guarantee: length and character variety raise the score; common passwords, repeats
 * and simple sequences lower it.
 */

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface Strength {
  score: StrengthScore;
  label: "Very weak" | "Weak" | "Fair" | "Good" | "Strong";
}

const LABELS: Strength["label"][] = ["Very weak", "Weak", "Fair", "Good", "Strong"];

const COMMON = new Set([
  "password",
  "passw0rd",
  "123456",
  "12345678",
  "123456789",
  "qwerty",
  "qwertyuiop",
  "abc123",
  "111111",
  "letmein",
  "welcome",
  "admin",
  "iloveyou",
  "monkey",
  "dragon",
  "football",
  "sunshine",
  "princess",
  "secret",
  "changeme",
]);

const SEQUENCES = [
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
];

function reversed(text: string): string {
  let out = "";
  for (let i = text.length - 1; i >= 0; i--) out += text.charAt(i);
  return out;
}

/** Keyboard/alphabet runs, both directions (all plain ASCII). */
const RUNS = [...SEQUENCES, ...SEQUENCES.map(reversed)];

function hasSequence(pw: string, length = 4): boolean {
  const lower = pw.toLowerCase();
  return RUNS.some((seq) => {
    for (let i = 0; i + length <= seq.length; i++) {
      if (lower.includes(seq.slice(i, i + length))) return true;
    }
    return false;
  });
}

export function passwordStrength(password: string): Strength {
  if (!password) return { score: 0, label: LABELS[0] ?? "Very weak" };
  const lower = password.toLowerCase();
  // "Password1!" is still "password": check the letters alone too.
  const letters = lower.replace(/[^a-z]/g, "");
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9]/g, "")) || COMMON.has(letters)) {
    return { score: 0, label: "Very weak" };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  const unique = new Set(password).size;
  let points = 0;
  points += Math.min(password.length, 24) * 3; // length matters most
  points += (classes - 1) * 6;
  if (unique < password.length / 2) points -= 15; // lots of repeats
  if (/(.)\1{2,}/.test(password)) points -= 10; // "aaa"
  if (hasSequence(password)) points -= 15; // "1234", "abcd", "qwer"
  const score: StrengthScore =
    points < 20 ? 0 : points < 30 ? 1 : points < 45 ? 2 : points < 60 ? 3 : 4;
  return { score, label: LABELS[score] ?? "Very weak" };
}
