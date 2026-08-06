---
name: streamlit-caching-recommendation
description: Recommendation to begin with Streamlit caching and adopt Valkey only if needed
status: current
document_type: recommendation
last_updated: 2026-07-28
---

# Streamlit Caching Recommendation

## Recommendation

For a Streamlit application running locally on a Windows 11 laptop in a Python virtual environment, start with **Streamlit's built-in caching**. Add **Valkey** later only when the application has requirements that Streamlit's cache cannot meet.

## Stage 1: Streamlit's built-in cache

Streamlit's cache is the best starting point for a local, single-user application because it:

- requires no additional service to install or maintain;
- is integrated directly into Streamlit;
- is suitable for expensive calculations, file loading, API responses, database queries, and reusable resources such as machine-learning models;
- keeps development and troubleshooting simple.

For many local Streamlit applications, this may be all that is needed.

## Stage 2: Valkey

Consider adding Valkey when one or more of these needs arise:

- multiple users access the application;
- multiple Streamlit processes need to share cached data;
- cached data should survive an application restart;
- several applications need to share the same cache;
- the application needs shared counters, rate limiting, queues, distributed locks, or publish/subscribe messaging;
- the application is moving toward a distributed or production deployment.

In this role, Valkey is a separate shared service rather than a cache contained inside the Streamlit process. On Windows 11, it would normally run through Docker Desktop or WSL2, while the Streamlit application and its Python client continue running in the existing virtual environment.

## Rule of thumb

- **One developer and one local application:** use Streamlit's cache.
- **Multiple users, processes, or applications:** consider Valkey.
- **Distributed or production deployment:** Valkey is often the stronger choice.

## Conclusion

Do not add Valkey merely because it is available. Begin with Streamlit's built-in cache and keep the architecture simple. Introduce Valkey when there is a concrete requirement for shared, persistent, or distributed caching. Valkey can complement Streamlit's cache; it does not necessarily need to replace it entirely.
