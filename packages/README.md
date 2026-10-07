# Shared packages

`@tsms/config` owns shared TypeScript presets and server-only environment parsers, consumed by API/worker. Do not import it into browser/mobile bundles.

The target ui, types, validation, database, auth, events, learning, and ai packages are deferred until a stage has actual shared behavior/contracts to place in them. Do not create empty implementations. UI sharing across React DOM and React Native needs a real design decision when components exist.
