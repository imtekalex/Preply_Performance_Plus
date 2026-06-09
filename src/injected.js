(() => {
  const MESSAGE_REQUEST = "PREPLY_PLUS_FETCH_REPORTS";
  const MESSAGE_RESPONSE = "PREPLY_PLUS_REPORTS_RESULT";
  const STUDENT_MESSAGE_REQUEST = "PREPLY_PLUS_FETCH_STUDENTS";
  const STUDENT_MESSAGE_RESPONSE = "PREPLY_PLUS_STUDENTS_RESULT";

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

  async function fetchStudents({ operationName, variables, query }) {
    const endpoint = `/graphql/v2/${encodeURIComponent(operationName || "TutorStudentManagement")}`;
    const response = await fetch(new URL(endpoint, window.location.origin).toString(), {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Apollo-Require-Preflight": "true",
        "Content-Type": "application/json",
        "X-Apollo-Operation-Name": operationName || "TutorStudentManagement"
      },
      body: JSON.stringify({
        operationName,
        variables,
        query
      })
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    }

    const payload = JSON.parse(text);
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }

    const tutorings = payload.data?.currentUser?.tutor?.studentManagementTutorings;
    return {
      totalCount: tutorings?.totalCount || 0,
      nodes: tutorings?.nodes || []
    };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) {
      return;
    }

    if (event.data?.type === STUDENT_MESSAGE_REQUEST) {
      const { requestId, operationName, variables, query } = event.data;

      try {
        const result = await fetchStudents({ operationName, variables, query });
        window.postMessage(
          {
            type: STUDENT_MESSAGE_RESPONSE,
            requestId,
            ...result
          },
          window.location.origin
        );
      } catch (error) {
        window.postMessage(
          {
            type: STUDENT_MESSAGE_RESPONSE,
            requestId,
            error: error instanceof Error ? error.message : String(error)
          },
          window.location.origin
        );
      }
      return;
    }

    if (event.data?.type !== MESSAGE_REQUEST) {
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
