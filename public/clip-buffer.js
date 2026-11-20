(function exposeClipBuffer(globalScope) {
  // Walk backwards through the recorded segments until we have at least
  // `wantedDurationMs` of footage. `startOffsetMs` is the surplus at the start
  // that the server trims away.
  function selectClipSegments(segments, wantedDurationMs) {
    let startIndex = segments.length;
    let selectedDurationMs = 0;

    while (startIndex > 0 && selectedDurationMs < wantedDurationMs) {
      startIndex -= 1;
      selectedDurationMs += segments[startIndex].durationMs;
    }

    return {
      segments: segments.slice(startIndex),
      startOffsetMs: Math.max(0, selectedDurationMs - wantedDurationMs),
      selectedDurationMs,
    };
  }

  globalScope.selectClipSegments = selectClipSegments;
  if (typeof module !== 'undefined') module.exports = { selectClipSegments };
})(typeof window !== 'undefined' ? window : globalThis);
