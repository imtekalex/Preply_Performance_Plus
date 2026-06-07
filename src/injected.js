(() => {
  const MESSAGE_REQUEST = "PREPLY_PLUS_FETCH_REPORTS";
  const MESSAGE_RESPONSE = "PREPLY_PLUS_REPORTS_RESULT";

  async function fetchReport(range) {
    const url = new URL("/tutor/download-earnings-report", window.location.origin);
    url.searchParams.set("timestampStart", range.start);
    url.searchParams.set("timestampEnd", range.end);
    url.searchParams.set("format", "csv");

    const response = await fetch(url.toString(), {
      credentials: "include",
      headers: {
        Accept: "text/csv,application/csv,text/plain,*/*"
      }
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    }

    return {
      id: range.id,
      start: range.start,
      end: range.end,
      contentType: response.headers.get("content-type") || "",
      text
    };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.type !== MESSAGE_REQUEST) {
      return;
    }

    const { requestId, ranges } = event.data;
    const reports = [];
    const errors = [];

    for (const range of ranges || []) {
      try {
        reports.push(await fetchReport(range));
      } catch (error) {
        errors.push({
          id: range.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    window.postMessage(
      {
        type: MESSAGE_RESPONSE,
        requestId,
        reports,
        errors
      },
      window.location.origin
    );
  });
})();
