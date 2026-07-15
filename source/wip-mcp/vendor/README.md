# Vendored Ocean background-agent WIP runtime

This directory contains the complete runnable WIP distribution produced by the
matching Ocean spike. Rebuild and replace it as a unit whenever the Ocean spike
changes. The required entrypoint is:

```text
bin/polygraph-mcp.mjs
```

The outer launcher fails closed if this entrypoint is absent. It never falls
back to a production package.
