package ws

// gorilla does not export its internal conn constructor; tests use the real
// Upgrader/Dialer over httptest (see batching_e2e_test.go). This file keeps the
// shared test-envelope wire helper documented next to the frame package limits.

// testEnvBytes + decodeEnvelopeStream live in batching_e2e_test.go.
