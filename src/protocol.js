(() => {
  const shared = {
    messageTypes: Object.freeze({
      reportsRequest: "PREPLY_PLUS_FETCH_REPORTS",
      reportsResponse: "PREPLY_PLUS_REPORTS_RESULT",
      studentsRequest: "PREPLY_PLUS_FETCH_STUDENTS",
      studentsResponse: "PREPLY_PLUS_STUDENTS_RESULT"
    }),
    studentOperationName: "TutorStudentManagement"
  };

  if (!window.__PREPLY_PLUS_SHARED__) {
    Object.defineProperty(window, "__PREPLY_PLUS_SHARED__", {
      value: Object.freeze(shared),
      configurable: false,
      enumerable: false,
      writable: false
    });
  }
})();
