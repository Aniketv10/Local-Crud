// App.js
// ===========================================
// Task Manager (LocalStorage) — Fully Responsive
// ===========================================
//
// Flow (big picture):
// 1) Boot: We read from localStorage into React state.
// 2) UI State: We manage input text, filters, priority, etc.
// 3) Derived Data: We compute visibleTodos (filter + search) and progress.
// 4) CRUD: create/update/delete/toggle save back to localStorage.
// 5) Layout: 100dvh shell -> sticky topbar + footer, scrollable middle list.
// 6) UX: live clock, relative timestamps, a11y labels, keyboard Esc to cancel.
//
// Why?
// - React state drives UI (single source of truth).
// - localStorage keeps data across refreshes (zero backend).
// - Derived data keeps rendering fast & declarative.
// - Responsive layout makes it usable on phone/tablet/desktop.

import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/* =========================
   Config & helpers
   ========================= */

// localStorage key + schema version (in case we change stored shape later)
const STORAGE_KEY = "todos_v3";
const SCHEMA_VERSION = 3;

/**
 * uid(): ESLint-safe unique ID generator.
 * - Uses window.crypto.randomUUID() if available (stable UUID v4)
 * - Fallback: timestamp + random string → unique enough for client-side lists
 */
const uid = () => {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
};

// Normalize/clean up user text (collapse spaces, trim ends)
const sanitize = (s) => s.replace(/\s+/g, " ").trim();

// "2 items" vs "1 item" helper (nice microcopy)
const plural = (n, s, p = s + "s") => `${n} ${n === 1 ? s : p}`;

// Priority options (used by form + filter)
const PRIORITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/**
 * relativeTime(ts, nowMs): small formatter like "2m ago", "3h ago", "4d ago"
 * improves readability vs exact timestamps for list items
 */
function relativeTime(ts, nowMs) {
  const diff = Math.max(0, nowMs - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* =========================
   LocalStorage hook
   =========================
   Why a hook?
   - Encapsulates parsing, schema guarding, and try/catch.
   - Keeps component clean and focused on UI logic.
*/
function useLocalStorageObject(key, initialFactory) {
  // Initialize state from localStorage (or fallback to initialFactory)
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return initialFactory(); // nothing stored yet
      const parsed = JSON.parse(raw);

      // Minimal schema/version check to avoid breaking if shape changes
      if (parsed?.__v !== SCHEMA_VERSION || !Array.isArray(parsed?.items)) {
        return initialFactory();
      }
      return parsed;
    } catch {
      // Corrupt JSON or private mode issues → start fresh
      return initialFactory();
    }
  });

  // Persist any state change back to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Write may fail (quota/private mode). We ignore; UI still works in memory.
    }
  }, [key, state]);

  return [state, setState];
}

/* =========================
   App (root component)
   ========================= */
export default function App() {
  // Storage object: { __v, items: Todo[] }
  const [store, setStore] = useLocalStorageObject(STORAGE_KEY, () => ({
    __v: SCHEMA_VERSION,
    items: [],
  }));
  const todos = store.items; // convenience reference

  // --- UI state (controlled inputs, filters, etc.) ---
  const [text, setText] = useState("");            // add/edit text field
  const [priority, setPriority] = useState("medium"); // add/edit priority
  const [editingId, setEditingId] = useState(null);   // null: create mode; otherwise editing
  const [filter, setFilter] = useState("all");        // all | active | completed
  const [priorityFilter, setPriorityFilter] = useState("all"); // all | low | medium | high
  const [q, setQ] = useState(""); // search query
  const inputRef = useRef(null);  // for focus management when editing

  // Live clock (for header and relative time updates)
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000); // tick every second
    return () => clearInterval(id);
  }, []);

  // Derived counts kept memoized to avoid recalculating unnecessarily
  const activeCount = useMemo(
    () => todos.filter((t) => !t.completed).length,
    [todos]
  );

  // Completion % for progress bar (purely presentational)
  const completionPct = useMemo(() => {
    if (!todos.length) return 0;
    const done = todos.filter((t) => t.completed).length;
    return Math.round((done / todos.length) * 100);
  }, [todos]);

  /**
   * visibleTodos:
   * - Apply status filter (all/active/completed)
   * - Apply priority filter (all/low/medium/high)
   * - Apply text search (case-insensitive)
   * - Sort newest first (createdAt desc)
   * useMemo → recompute only when inputs change
   */
  const visibleTodos = useMemo(() => {
    let arr = todos;

    if (filter === "active") arr = arr.filter((t) => !t.completed);
    if (filter === "completed") arr = arr.filter((t) => t.completed);

    if (priorityFilter !== "all") arr = arr.filter((t) => t.priority === priorityFilter);

    const query = sanitize(q).toLowerCase();
    if (query) arr = arr.filter((t) => t.text.toLowerCase().includes(query));

    return [...arr].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [todos, filter, priorityFilter, q]);

  /* =========================
     CRUD operations
     ========================= */

  // CREATE: add a new todo to the beginning of the list
  const createTodo = (rawText, prio) => {
    const val = sanitize(rawText);
    if (!val) return; // ignore empty
    const t = {
      id: uid(),             // unique id for list keying/edit/delete
      text: val,
      completed: false,
      priority: prio,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // setStore uses functional update to avoid stale closures
    setStore((s) => ({ ...s, items: [t, ...s.items] }));
  };

  // UPDATE: patch a todo by id
  const updateTodo = (id, patch) => {
    setStore((s) => ({
      ...s,
      items: s.items.map((t) =>
        t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t
      ),
    }));
  };

  // DELETE: remove a todo
  const deleteTodo = (id) => {
    setStore((s) => ({ ...s, items: s.items.filter((t) => t.id !== id) }));
    if (editingId === id) cancelEdit(); // if we deleted the one being edited, exit edit mode
  };

  // DELETE ALL: clear entire list (with confirmation)
  const clearAll = () => {
    if (!window.confirm("Clear all todos? This cannot be undone.")) return;
    setStore((s) => ({ ...s, items: [] }));
    cancelEdit();
  };

  /* =========================
     Form & item event handlers
     ========================= */

  // Add or Update submit handler
  const onSubmit = (e) => {
    e.preventDefault();
    if (!sanitize(text)) return; // guard empty

    if (editingId) {
      // EDIT MODE: patch existing
      updateTodo(editingId, { text: sanitize(text), priority });
      setEditingId(null);
    } else {
      // CREATE MODE
      createTodo(text, priority);
    }
    // Reset form fields after action
    setText("");
    setPriority("medium");
  };

  // Start editing a specific todo → prefill inputs, focus text field
  const startEdit = (t) => {
    setEditingId(t.id);
    setText(t.text);
    setPriority(t.priority || "medium");
    // Focus next frame to ensure the input is present in DOM
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Exit edit mode (also used by Esc key)
  const cancelEdit = () => {
    setEditingId(null);
    setText("");
    setPriority("medium");
  };

  // Toggle completed flag
  const toggleComplete = (id) => {
    const t = todos.find((x) => x.id === id);
    if (!t) return;
    updateTodo(id, { completed: !t.completed });
  };

  // UX: Esc cancels edit quickly
  const onKeyDownInput = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  /* =========================
     Render
     =========================
     Layout:
     - .app_shell (100dvh/100svh container) keeps app fullscreen without body scroll
     - .topbar & .footerbar are sticky within the shell
     - .scroll_area hosts the long list and is the only scrollable section
  */
  return (
    <div className="app_shell">
      {/* ===== Topbar: branding + filters + progress + form ===== */}
      <div className="topbar">
        <div className="brand_block">
          <h1 className="title">Tasks</h1>

          {/* Live time + counts; aria-live lets screen readers get updates */}
          <div className="brand_meta">
            <span className="clock" aria-live="polite">
              {new Date(now).toLocaleString()}
            </span>
            <span className="divider">•</span>
            <span className="meta_count">
              {plural(todos.length, "item")} · {plural(activeCount, "active")}
            </span>
          </div>
        </div>

        {/* Search + Filters (status + priority) */}
        <div className="filters_row" role="region" aria-label="Search and filters">
          <input
            className="input text search_input"
            type="search"
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search todos"
          />

          <div className="segmented" role="tablist" aria-label="Status filter">
            {["all", "active", "completed"].map((f) => (
              <button
                key={f}
                className={`segmented_btn ${filter === f ? "is-active" : ""}`}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
              >
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <select
            className="input select priority_select"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            aria-label="Priority filter"
          >
            <option value="all">All priorities</option>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {/* Completion progress bar */}
        <div className="progress_wrap" aria-label="Completion progress">
          <div className="progress_track">
            <div
              className="progress_bar"
              style={{ width: `${completionPct}%` }}
              aria-valuenow={completionPct}
              aria-valuemin={0}
              aria-valuemax={100}
              role="progressbar"
            />
          </div>
          <span className="progress_label">{completionPct}% done</span>
        </div>

        {/* Add / Edit form */}
        <form className="todo_form" onSubmit={onSubmit} aria-label="Add or edit task">
          <input
            ref={inputRef}
            type="text"
            className="input text todo_input"
            value={text}
            placeholder={editingId ? "Update task…" : "Add a new task…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDownInput}
            aria-label={editingId ? "Task text, editing" : "Task text"}
          />
          <select
            className="input select"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            aria-label="Priority"
          >
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>

          <button className="btn primary" type="submit">
            {editingId ? "Update" : "Add"}
          </button>
          {editingId && (
            <button className="btn ghost" type="button" onClick={cancelEdit}>
              Cancel
            </button>
          )}
        </form>
      </div>

      {/* ===== Scrollable list area (only thing that scrolls) ===== */}
      <div className="scroll_area">
        <ul className="todo_list" aria-label="Task list">
          {visibleTodos.map((todo) => (
            <li key={todo.id} className="todo_item fade_in">
              {/* Left: checkbox + text */}
              <label className="todo_left">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={todo.completed}
                  onChange={() => toggleComplete(todo.id)}
                  aria-label={todo.completed ? "Mark as active" : "Mark as completed"}
                />
                <span className={`todo_text ${todo.completed ? "done" : ""}`}>
                  {todo.text}
                </span>
              </label>

              {/* Middle: priority chip + relative time */}
              <div className="todo_meta">
                <span className={`chip ${todo.priority}`}>{todo.priority}</span>
                <span className="muted">{relativeTime(todo.createdAt, now)}</span>
              </div>

              {/* Right: edit/delete */}
              <div className="todo_actions">
                <button className="btn small" onClick={() => startEdit(todo)} aria-label="Edit">
                  Edit
                </button>
                <button
                  className="btn small danger"
                  onClick={() => deleteTodo(todo.id)}
                  aria-label="Delete"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>

        {/* Empty states: either no tasks at all, or filter/search hides them */}
        {visibleTodos.length === 0 && (
          <p className="empty_state" role="status">
            {todos.length === 0
              ? "No tasks yet. Add the first one above."
              : "Nothing matches your filter/search."}
          </p>
        )}
      </div>

      {/* ===== Footerbar (sticky inside 100vh shell) ===== */}
      <div className="footerbar">
        <span className="count_line">
          Showing {plural(visibleTodos.length, "task")} · {plural(activeCount, "active")}
        </span>
        {todos.length > 0 && (
          <button className="btn danger" onClick={clearAll}>
            Clear All
          </button>
        )}
      </div>
    </div>
  );
}
