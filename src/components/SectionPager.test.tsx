// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SectionPager, { useSectionPager } from "./SectionPager";

type HarnessProps = {
  count: number;
  defaultPage?: number;
  onPageChange?: (page: number) => void;
  page?: number;
  resetKey?: unknown;
};

function Harness(props: HarnessProps) {
  const pager = useSectionPager(props);

  return (
    <>
      <output data-testid="range">
        {pager.start}-{pager.end}
      </output>
      <SectionPager label="Ready" {...pager} />
    </>
  );
}

afterEach(cleanup);

describe("SectionPager", () => {
  it("only paginates when a section has more than 20 items", () => {
    const view = render(<Harness count={20} />);

    expect(
      screen.queryByRole("navigation", { name: "Ready pagination" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("range")).toHaveTextContent("0-20");

    view.rerender(<Harness count={21} />);

    expect(
      screen.getByRole("navigation", { name: "Ready pagination" }),
    ).toHaveAttribute("data-pages", "2");
    expect(screen.getByText("Page 1 of 2")).toBeVisible();
    expect(screen.getByTestId("range")).toHaveTextContent("0-20");
  });

  it("moves independently through all three pages for 41 items", () => {
    render(<Harness count={41} />);

    const next = screen.getByRole("button", { name: "Next ready page" });
    fireEvent.click(next);
    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    expect(screen.getByTestId("range")).toHaveTextContent("20-40");
    fireEvent.click(next);
    expect(screen.getByText("Page 3 of 3")).toBeVisible();
    expect(screen.getByTestId("range")).toHaveTextContent("40-41");
    expect(next).toBeDisabled();
  });

  it("clamps after removal while staying stable across same-size refreshes", async () => {
    const changed = vi.fn();
    const view = render(<Harness count={41} onPageChange={changed} />);
    const next = screen.getByRole("button", { name: "Next ready page" });
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText("Page 3 of 3")).toBeVisible();

    view.rerender(<Harness count={41} onPageChange={changed} />);
    expect(screen.getByText("Page 3 of 3")).toBeVisible();

    view.rerender(<Harness count={21} onPageChange={changed} />);
    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(screen.getByTestId("range")).toHaveTextContent("20-21");
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(2));

    view.rerender(<Harness count={20} onPageChange={changed} />);
    expect(
      screen.queryByRole("navigation", { name: "Ready pagination" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("range")).toHaveTextContent("0-20");
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(1));
  });

  it("supports a controlled page and an explicit reset request", async () => {
    const changed = vi.fn();
    const view = render(
      <Harness count={41} onPageChange={changed} page={2} resetKey={0} />,
    );

    expect(screen.getByText("Page 2 of 3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next ready page" }));
    expect(changed).toHaveBeenCalledWith(3);
    expect(screen.getByText("Page 2 of 3")).toBeVisible();

    view.rerender(
      <Harness count={41} onPageChange={changed} page={2} resetKey={1} />,
    );
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith(1));

    view.rerender(
      <Harness count={41} onPageChange={changed} page={1} resetKey={1} />,
    );
    expect(screen.getByText("Page 1 of 3")).toBeVisible();
  });
});
