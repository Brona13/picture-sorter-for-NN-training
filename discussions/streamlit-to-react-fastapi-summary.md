# Streamlit → React + FastAPI + SQLite: summary

## Why the question came up
- Streamlit re-runs the whole script on every interaction. It is good for data in, data out: filters, tables, charts, exports.
- Interactive features like drag-and-drop and drawing on a canvas fight that model. The ROI canvas problems in this chat are an example.
- React runs in the browser and re-renders only what changed. It gives more control over interaction, but it takes more work to build.
- For small apps, either choice is workable.

## Target architecture
- **Frontend:** React (JavaScript, runs in the browser).
- **Backend:** Python with FastAPI, wrapping the existing data and processing code mostly as-is.
- **Database:** SQLite. Confirmed as the app's database; it suits a portable setup because it is just a file.
- React cannot read SQLite directly, so it talks to the FastAPI backend over HTTP (the API).

## Decisions made
- One repo with two subfolders: `backend/` and `frontend/`. The existing Python files move into `backend/` largely unchanged.
- Run a new Claude Code session on the Linux machine with access to the existing scripts. It scaffolds the new folders and migrates in logical steps.
- Migrate **view by view**, not all at once.
- Start with the **backend**: build the API endpoints for the simplest view, confirm they return real data, then build that one React view against them. Starting with the frontend would mean mocking data and redoing it.

## Other things to plan for
- Authentication or access control, if more than one person will use it.
- File and storage paths must work the same way behind an API as they do now.

## Hybrid option (not chosen)
- Keep Streamlit and build only the canvas editor as a separate React page.
- It means two web servers running at once (for example ports 8501 and 3000), sharing data through the same database or an API.
- The look would be inconsistent at the handoff. Leaning against it.

## Effort estimate
- Roughly several weeks of evening and weekend work with an AI coding tool and testing as you go.
- This is a ballpark based only on the description (about 15 to 20 Python files, several views, a database layer). The rest of the code has not been seen, so it is not a real estimate.

## Still open
- Whether to rewrite at all, or stay on Streamlit.
- Which view is the simplest one to migrate first.
