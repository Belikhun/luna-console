// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The script the agent's browser sessions (`browser.ts`) install in a page,
 * as source text: it runs inside Chromium, in an isolated world of its own
 * (`luna`), so the page's scripts cannot see or tamper with it while it
 * shares their DOM.
 *
 * It finds elements (by a ref it handed out, a selector or visible text),
 * writes the outline the agent reads, and draws what people watching should
 * see: the agent's pointer, gliding between positions, a ripple where it
 * clicks, and labelled highlight boxes. The drawing lives in one element
 * (`<luna-agent-layer>`) on the root, with a closed shadow root for its
 * styles, pointer events off so every click reaches the page underneath, and
 * the top z-index, so it shows in the screencast and in screenshots alike.
 *
 * Kept as plain JavaScript in a string: it is evaluated in the page, never
 * imported here.
 */

/** Installs `globalThis.__luna` once per document; evaluating it again does nothing. */
export const PAGE_HELPER = String.raw`(() => {
	if (globalThis.__luna) {
		return;
	}

	const refs = new Map();
	const ids = new WeakMap();
	let nextRef = 1;
	let layer = null;
	let cursorEl = null;
	let boxes = [];
	let laidOut = false;

	const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [contenteditable=''], [contenteditable=true], [tabindex]:not([tabindex='-1'])";

	function refOf(el) {
		let ref = ids.get(el);

		if (!ref) {
			ref = "e" + nextRef++;
			ids.set(el, ref);
			refs.set(ref, new WeakRef(el));
		}

		return ref;
	}

	function visible(el) {
		if (!(el instanceof Element) || !el.isConnected) {
			return false;
		}

		const style = getComputedStyle(el);

		if (style.visibility === "hidden" || style.display === "none") {
			return false;
		}

		const rect = el.getBoundingClientRect();

		return rect.width > 0 && rect.height > 0;
	}

	function own(el) {
		return layer !== null && (el === layer || layer.contains(el));
	}

	function textOf(el) {
		return (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
	}

	function nameOf(el) {
		const aria = el.getAttribute("aria-label");

		if (aria) {
			return aria.trim();
		}

		const labelledBy = el.getAttribute("aria-labelledby");

		if (labelledBy) {
			const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(" ");

			if (text) {
				return text;
			}
		}

		if (el instanceof HTMLImageElement) {
			return el.alt ?? "";
		}

		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
			const label = el.labels && el.labels[0] ? textOf(el.labels[0]) : "";

			if (label) {
				return label;
			}

			if ("placeholder" in el && el.placeholder) {
				return el.placeholder;
			}

			if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) {
				return el.value;
			}
		}

		return textOf(el).slice(0, 100);
	}

	function roleOf(el) {
		const explicit = el.getAttribute("role");

		if (explicit) {
			return explicit;
		}

		const tag = el.tagName.toLowerCase();

		if (/^h[1-6]$/.test(tag)) {
			return "heading " + tag.slice(1);
		}

		if (tag === "input") {
			const type = (el.getAttribute("type") ?? "text").toLowerCase();

			return ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", range: "slider", image: "button" })[type] ?? "textbox";
		}

		return ({
			a: "link",
			button: "button",
			select: "combobox",
			textarea: "textbox",
			img: "img",
			nav: "navigation",
			main: "main",
			header: "banner",
			footer: "contentinfo",
			aside: "complementary",
			form: "form",
			summary: "button",
			dialog: "dialog",
			ul: "list",
			ol: "list",
			table: "table"
		})[tag] ?? tag;
	}

	function find(spec) {
		if (!spec) {
			return null;
		}

		if (spec.ref) {
			const el = refs.get(spec.ref)?.deref();

			if (!el || !el.isConnected) {
				throw new Error("the ref " + spec.ref + " is unknown or gone from the page; take a new outline with browser_read");
			}

			return el;
		}

		if (spec.selector) {
			let el;

			try {
				el = document.querySelector(spec.selector);
			} catch {
				throw new Error("not a CSS selector: " + spec.selector);
			}

			if (!el) {
				throw new Error("nothing on the page matches " + spec.selector);
			}

			return el;
		}

		if (spec.text) {
			const wanted = spec.text.toLowerCase().replace(/\s+/g, " ").trim();
			let best = null;
			let bestScore = Infinity;

			for (const el of document.body ? document.body.querySelectorAll("*") : []) {
				if (own(el) || el.tagName === "SCRIPT" || el.tagName === "STYLE") {
					continue;
				}

				const haystack = (textOf(el) + " " + (el.getAttribute("aria-label") ?? "") + " " + (el.value && typeof el.value === "string" ? el.value : "")).toLowerCase();

				if (!haystack.includes(wanted) || !visible(el)) {
					continue;
				}

				// the smallest element holding the text, an interactive one first
				const score = textOf(el).length - (el.matches(INTERACTIVE) ? 10000 : 0);

				if (score < bestScore) {
					best = el;
					bestScore = score;
				}
			}

			if (!best) {
				throw new Error("no visible element on the page shows the text \"" + spec.text + "\"");
			}

			return best;
		}

		return null;
	}

	function describe(el) {
		return { ref: refOf(el), role: roleOf(el), name: nameOf(el).slice(0, 120) };
	}

	// -- what people see: the layer, the pointer, the highlights ----------------

	function ensureLayer() {
		if (layer && layer.isConnected) {
			return layer.__root;
		}

		layer = document.createElement("luna-agent-layer");
		layer.setAttribute("aria-hidden", "true");
		layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;contain:layout;";

		const root = layer.attachShadow({ mode: "closed" });

		root.innerHTML = "<style>"
			+ ":host{all:initial}"
			+ ".box{position:fixed;border:2px solid #ff9900;border-radius:6px;background:rgba(255,153,0,.12);box-shadow:0 0 0 3px rgba(255,153,0,.25);transition:all .2s ease}"
			+ ".tag{position:absolute;left:-2px;bottom:100%;margin-bottom:4px;padding:2px 8px;border-radius:6px;background:#ff9900;color:#16191f;font:600 12px/1.5 system-ui,sans-serif;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}"
			+ ".tag.below{bottom:auto;top:100%;margin:4px 0 0}"
			+ ".cursor{position:fixed;left:0;top:0;width:28px;height:28px;transform:translate(-200px,-200px);transition:transform .45s cubic-bezier(.3,.7,.3,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}"
			+ ".cursor.instant{transition:none}"
			+ ".cursor svg{width:28px;height:28px;display:block}"
			+ ".who{position:absolute;left:22px;top:22px;padding:2px 8px;border-radius:999px;background:#0972d3;color:#fff;font:600 11px/1.5 system-ui,sans-serif;white-space:nowrap}"
			+ ".ripple{position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border:2px solid #ff9900;border-radius:50%;animation:ripple .6s ease-out forwards}"
			+ "@keyframes ripple{to{transform:scale(4);opacity:0}}"
			+ "</style>";
		layer.__root = root;
		document.documentElement.appendChild(layer);

		if (!laidOut) {
			laidOut = true;

			const relayout = () => requestAnimationFrame(layoutBoxes);

			addEventListener("scroll", relayout, { capture: true, passive: true });
			addEventListener("resize", relayout, { passive: true });
		}

		return root;
	}

	function layoutBoxes() {
		for (const box of boxes) {
			const rect = box.el.getBoundingClientRect();
			const gone = !box.el.isConnected || rect.width === 0;

			box.node.style.display = gone ? "none" : "block";
			box.node.style.left = (rect.left - 4) + "px";
			box.node.style.top = (rect.top - 4) + "px";
			box.node.style.width = (rect.width + 8) + "px";
			box.node.style.height = (rect.height + 8) + "px";
			box.tag?.classList.toggle("below", rect.top < 28);
		}
	}

	const ARROW = "<svg viewBox='0 0 28 28' xmlns='http://www.w3.org/2000/svg'><path d='M5 3 L5 22 L10 17.5 L13.5 25 L17 23.5 L13.5 16 L20 16 Z' fill='#fff' stroke='#16191f' stroke-width='1.6' stroke-linejoin='round'/></svg>";

	function cursor(x, y, instant, label) {
		const root = ensureLayer();

		if (!cursorEl || !cursorEl.isConnected) {
			cursorEl = document.createElement("div");
			cursorEl.className = "cursor instant";
			cursorEl.innerHTML = ARROW + "<span class='who'></span>";
			root.appendChild(cursorEl);
			void cursorEl.offsetWidth;
		}

		cursorEl.querySelector(".who").textContent = label || "Mèo Béo";
		cursorEl.classList.toggle("instant", !!instant);
		// the arrow's tip is at (5, 3) in its box
		cursorEl.style.transform = "translate(" + (x - 5) + "px," + (y - 3) + "px)";
		cursorEl.style.display = "block";
	}

	function hideCursor() {
		if (cursorEl) {
			cursorEl.style.display = "none";
		}
	}

	function ripple(x, y) {
		const root = ensureLayer();
		const dot = document.createElement("div");

		dot.className = "ripple";
		dot.style.left = x + "px";
		dot.style.top = y + "px";
		root.appendChild(dot);
		setTimeout(() => dot.remove(), 700);
	}

	function clearHighlights() {
		for (const box of boxes) {
			box.node.remove();
		}

		boxes = [];
	}

	globalThis.__luna = {
		/** Scroll an element to the middle of the viewport; its centre and size in viewport pixels */
		locate(spec) {
			const el = find(spec);

			if (!el) {
				throw new Error("name an element: ref, selector or text");
			}

			el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

			const rect = el.getBoundingClientRect();

			return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height, ...describe(el) };
		},

		/** An element's box in page pixels, for a clipped screenshot */
		box(spec) {
			const el = find(spec);

			el.scrollIntoView({ block: "nearest", behavior: "instant" });

			const rect = el.getBoundingClientRect();

			return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height, ...describe(el) };
		},

		focus(spec) {
			const el = find(spec);

			el.scrollIntoView({ block: "center", behavior: "instant" });
			el.focus();

			return describe(el);
		},

		clear(spec) {
			const el = spec ? find(spec) : document.activeElement;

			if (!el) {
				return null;
			}

			el.focus();

			if ("value" in el) {
				el.value = "";
				el.dispatchEvent(new Event("input", { bubbles: true }));
			} else if (el.isContentEditable) {
				el.textContent = "";
			}

			return describe(el);
		},

		select(spec, values) {
			const el = find(spec);

			if (!(el instanceof HTMLSelectElement)) {
				throw new Error("that element is a " + roleOf(el) + ", not a <select>");
			}

			const wanted = values.map((value) => value.toLowerCase());
			const picked = [];

			for (const option of el.options) {
				const hit = wanted.includes(option.value.toLowerCase()) || wanted.includes(option.label.toLowerCase().trim());

				if (hit && (el.multiple || picked.length === 0)) {
					option.selected = true;
					picked.push(option.label);
				} else if (el.multiple) {
					option.selected = false;
				}
			}

			if (picked.length === 0) {
				throw new Error("no option matches " + values.join(", ") + "; the options are " + [...el.options].map((option) => option.label).join(", "));
			}

			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));

			return { ...describe(el), picked };
		},

		scroll(spec, dx, dy, to) {
			if (spec) {
				const el = find(spec);

				el.scrollIntoView({ block: "center", behavior: "smooth" });
			} else if (to === "top") {
				scrollTo({ top: 0, behavior: "smooth" });
			} else if (to === "bottom") {
				scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
			} else {
				scrollBy({ left: dx || 0, top: dy || 0, behavior: "smooth" });
			}
		},

		position() {
			return { x: Math.round(scrollX), y: Math.round(scrollY), width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportHeight: innerHeight };
		},

		highlight(items) {
			const root = ensureLayer();
			const missing = [];
			let drawn = 0;

			for (const item of items) {
				let el;

				try {
					el = find(item);
				} catch (err) {
					missing.push(String(err.message ?? err));
					continue;
				}

				const node = document.createElement("div");

				node.className = "box";

				let tag = null;

				if (item.label) {
					tag = document.createElement("span");
					tag.className = "tag";
					tag.textContent = item.label;
					node.appendChild(tag);
				}

				root.appendChild(node);
				boxes.push({ el, node, tag });
				drawn += 1;
			}

			if (drawn > 0) {
				boxes[boxes.length - drawn].el.scrollIntoView({ block: "center", behavior: "instant" });
			}

			layoutBoxes();

			return { drawn, missing };
		},

		clearHighlights,
		cursor,
		hideCursor,
		ripple,

		zoom(percent) {
			if (document.body) {
				document.body.style.zoom = percent === 100 ? "" : String(percent / 100);
			}
		},

		exists(spec) {
			try {
				return !!find(spec) && visible(find(spec));
			} catch {
				return false;
			}
		},

		text(spec, max) {
			const el = spec ? find(spec) : document.body;

			return el ? (el.innerText ?? "").slice(0, max) : "";
		},

		outline(spec, max) {
			const start = spec ? find(spec) : document.body;
			const lines = [];
			let size = 0;
			let cut = false;
			const LANDMARK = "header, nav, main, footer, aside, form, dialog, section[aria-label], [role=banner], [role=navigation], [role=main], [role=contentinfo], [role=dialog], [role=region]";
			const WANTED = "h1, h2, h3, h4, h5, h6, img[alt]:not([alt='']), label, p, li, td, th, " + INTERACTIVE + ", " + LANDMARK;

			function walk(node, depth) {
				for (const el of node.children) {
					if (cut || own(el) || el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "TEMPLATE") {
						continue;
					}

					const isLandmark = el.matches(LANDMARK);
					const wanted = el.matches(WANTED) && visible(el);
					// plain text containers are listed only when they hold no wanted element of their own
					const leafText = /^(P|LI|TD|TH|LABEL)$/.test(el.tagName) && !el.querySelector(WANTED);

					if (wanted && (isLandmark || leafText || !/^(P|LI|TD|TH|LABEL)$/.test(el.tagName))) {
						const role = roleOf(el);
						const parts = [refOf(el), role === "p" || role === "li" || role === "td" || role === "th" || role === "label" ? "text" : role];
						const name = isLandmark ? (el.getAttribute("aria-label") ?? "") : nameOf(el);

						if (name) {
							parts.push(JSON.stringify(name.slice(0, 120)));
						}

						if (el instanceof HTMLAnchorElement) {
							parts.push("-> " + (el.getAttribute("href") ?? ""));
						}

						if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !["checkbox", "radio", "submit", "button"].includes(el.type)) {
							parts.push("value=" + JSON.stringify(String(el.value).slice(0, 80)));
						}

						if (el instanceof HTMLSelectElement) {
							parts.push("value=" + JSON.stringify(el.selectedOptions[0]?.label ?? ""));
						}

						if (el.checked) {
							parts.push("checked");
						}

						if (el.disabled) {
							parts.push("disabled");
						}

						const line = "  ".repeat(depth) + parts.join(" ");

						size += line.length + 1;

						if (size > max) {
							cut = true;

							return;
						}

						lines.push(line);
					}

					if (!leafText) {
						walk(el, depth + (isLandmark && wanted ? 1 : 0));
					}
				}
			}

			if (start) {
				walk(start, 0);
			}

			return { lines, cut };
		}
	};
})()`;
