// Two-column card layout that fills gaps: each card, in page order, goes into whichever
// column is shorter so far ("masonry"). CSS columns can't do this -- they never split a card,
// so one tall card (lineup, a long pickups list) leaves the other column hundreds of px short.
// Layout only: the cards themselves are moved, never re-rendered, so their buttons keep working.

export function packCards(box) {
  if (!box) return;
  // Numbered on the first pack so a re-pack keeps page order, not left-column-then-right.
  const cards = [...box.querySelectorAll(":scope > .col > *, :scope > :not(.col)")];
  cards.forEach((c, i) => { c.dataset.order ??= i; });
  cards.sort((a, b) => a.dataset.order - b.dataset.order);
  const cols = [document.createElement("div"), document.createElement("div")];
  for (const c of cols) c.className = "col";
  box.replaceChildren(...cols);
  box.classList.add("packed");
  for (const card of cards) (cols[0].offsetHeight <= cols[1].offsetHeight ? cols[0] : cols[1]).appendChild(card);
}

// Card heights change with the width (text wraps), so re-pack when the area's own width
// changes. Watching the element, not window "resize": a scrollbar coming or going changes the
// width without a resize event, and iPhone Safari fires resize when the address bar hides.
export function repackOnResize(area, find) {
  let lastWidth = 0, timer = null;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w === lastWidth) return;
    lastWidth = w;
    clearTimeout(timer);
    timer = setTimeout(() => packCards(find()), 100);
  }).observe(area);
}
