// @vitest-environment jsdom
//
// docs/RULES.md §2 — an HTTP error is never an empty state — did not hold for
// images anywhere in the product. Avatar branched on whether a URL EXISTED,
// not on whether it LOADED, so its initials fallback was unreachable whenever
// a URL was present: a 401/404/502 from /api/blob-image painted a blank
// circle. There was no onError handler on any image in the codebase.
//
// These tests drive the img's error event directly, which is what a browser
// fires for a failed image response regardless of status code.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { Avatar } from "@/components/ui/Avatar";

afterEach(cleanup);

const BLOB_URL = "https://store123.blob.vercel-storage.com/tenants/t-1/face-a1.webp";

describe("Avatar — a failed image falls back to initials", () => {
  it("renders the image while it is loading fine", () => {
    render(<Avatar pictureUrl={BLOB_URL} name="Ada Lovelace" colorSeed="m-1" />);

    expect(screen.getByRole("img", { name: "Ada Lovelace" }).tagName).toBe("IMG");
    expect(screen.queryByText("AL")).toBeNull();
  });

  it("swaps to the initials fallback when the image errors", () => {
    render(<Avatar pictureUrl={BLOB_URL} name="Ada Lovelace" colorSeed="m-1" />);

    fireEvent.error(screen.getByRole("img", { name: "Ada Lovelace" }));

    // The <img> is gone and the two-letter fallback is what the user sees.
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("AL")).toBeTruthy();
    // Still labelled, so a screen reader gets the person rather than silence.
    expect(screen.getByRole("img", { name: "Ada Lovelace" })).toBeTruthy();
  });

  it("gives a NEW picture its own attempt after a previous one failed", () => {
    const { rerender } = render(
      <Avatar pictureUrl={BLOB_URL} name="Ada Lovelace" colorSeed="m-1" />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Ada Lovelace" }));
    expect(document.querySelector("img")).toBeNull();

    // A fresh upload must not be suppressed by the previous failure — this is
    // why the component remembers WHICH src failed rather than a boolean.
    rerender(
      <Avatar
        pictureUrl="https://store123.blob.vercel-storage.com/tenants/t-1/face-b2.webp"
        name="Ada Lovelace"
        colorSeed="m-1"
      />,
    );

    expect(document.querySelector("img")).not.toBeNull();
  });

  it("still shows initials when there is no picture at all", () => {
    render(<Avatar pictureUrl={null} name="Ada Lovelace" colorSeed="m-1" />);

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("AL")).toBeTruthy();
  });

  it("routes a Vercel Blob URL through the authenticated proxy", () => {
    render(<Avatar pictureUrl={BLOB_URL} name="Ada Lovelace" colorSeed="m-1" />);

    const img = document.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      `/api/blob-image?url=${encodeURIComponent(BLOB_URL)}`,
    );
  });
});

describe("Avatar — request cost (4f)", () => {
  it("loads lazily so a long member list does not fire every request at once", () => {
    // A 200-member list otherwise issues 200 image requests on mount, each a
    // serverless invocation plus a Blob API call.
    render(<Avatar pictureUrl={BLOB_URL} name="Ada Lovelace" colorSeed="m-1" />);

    expect(document.querySelector("img")?.getAttribute("loading")).toBe("lazy");
  });
});

/**
 * What is NOT covered here, stated rather than implied:
 *
 *  - That a real browser fires `error` for the specific responses this app
 *    produces (401 JSON, 404 JSON, 502 JSON). jsdom does not fetch images at
 *    all, so the handler is invoked directly. The behaviour relied on — an
 *    <img> whose response is not a decodable image fires `error` — is part of
 *    the HTML spec, not something asserted here.
 *  - Every OTHER image in the app. This fixes Avatar, which covers member and
 *    staff faces. Gym logos, announcement images and waiver signatures render
 *    through their own <img>/<Image> tags and still have no onError; see the
 *    report for the list.
 */
