import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import Page from "../app/page";

afterEach(cleanup);

it("offers a named editor region and explains editor availability", () => {
  render(<Page />);
  expect(screen.getByRole("region", { name: "Diagram editor" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/editor/i);
});
