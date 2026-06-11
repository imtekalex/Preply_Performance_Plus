(() => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  const moneyFormatter = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  });

  const rateFormatter = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  });

  const numberFormatter = new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: 1
  });

  const dateFormatter = new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "long"
  });

  const fullDateFormatter = new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  const timeFormatter = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit"
  });

  const monthFormatter = new Intl.DateTimeFormat("de-DE", {
    month: "short",
    year: "numeric"
  });

  function parseMoney(value) {
    if (!value) {
      return 0;
    }

    const match = String(value).replace(/\s/g, "").match(/-?[\d.,]+/);
    if (!match) {
      return 0;
    }

    const raw = match[0];
    const commaIndex = raw.lastIndexOf(",");
    const dotIndex = raw.lastIndexOf(".");
    let decimalSeparator = commaIndex > dotIndex ? "," : ".";

    if (commaIndex === -1 && dotIndex !== -1 && /^\d+\.\d{3}$/.test(raw)) {
      decimalSeparator = "";
    }
    if (dotIndex === -1 && commaIndex !== -1 && /^\d+,\d{3}$/.test(raw)) {
      decimalSeparator = "";
    }

    if (!decimalSeparator) {
      return Number.parseFloat(raw.replace(/[.,]/g, "")) || 0;
    }

    const normalized = raw
      .replace(new RegExp(`\\${decimalSeparator === "," ? "." : ","}`, "g"), "")
      .replace(decimalSeparator, ".");

    return Number.parseFloat(normalized) || 0;
  }

  function parseNumber(value) {
    if (!value) {
      return 0;
    }

    const match = String(value).replace(/\s/g, "").match(/-?[\d.,]+/);
    if (!match) {
      return 0;
    }

    return Number.parseFloat(match[0].replace(",", ".")) || 0;
  }

  function parseLessonCount(value, hasLessonRow = false) {
    if (!value) {
      return hasLessonRow ? 1 : 0;
    }

    const parsed = parseNumber(value);
    return parsed > 0 && parsed < 100 ? parsed : hasLessonRow ? 1 : 0;
  }

  function parseDurationHours(value, lessonCount) {
    if (!value) {
      return 0;
    }

    const text = String(value).toLowerCase();
    const parsed = parseNumber(text);
    if (!parsed) {
      return 0;
    }

    if (/min|minute|minuten/.test(text)) {
      return parsed / 60;
    }

    if (/hour|hours|std|stunde|stunden|h\b/.test(text)) {
      return parsed;
    }

    return parsed > 10 ? parsed / 60 : parsed;
  }

  function parseLessonPrice(value) {
    if (!value) {
      return 0;
    }

    const amount = parseNumber(value);
    if (!amount) {
      return 0;
    }

    if (amount >= 1000 && amount % 100 === 0) {
      return amount / 100;
    }

    return amount;
  }

  function parseDate(value) {
    if (!value) {
      return null;
    }

    const germanMatch = String(value).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (germanMatch) {
      return new Date(
        Number(germanMatch[3]),
        Number(germanMatch[2]) - 1,
        Number(germanMatch[1])
      );
    }

    const isoDateTimeMatch = String(value).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (isoDateTimeMatch) {
      return new Date(
        Number(isoDateTimeMatch[1]),
        Number(isoDateTimeMatch[2]) - 1,
        Number(isoDateTimeMatch[3]),
        Number(isoDateTimeMatch[4] || 0),
        Number(isoDateTimeMatch[5] || 0),
        Number(isoDateTimeMatch[6] || 0)
      );
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function money(value) {
    return moneyFormatter.format(value || 0);
  }

  function rateMoney(value) {
    return rateFormatter.format(value || 0);
  }

  function rateOrNA(value) {
    return value ? rateMoney(value) : "n/a";
  }

  function number(value) {
    return numberFormatter.format(value || 0);
  }

  function formatMonth(date) {
    return monthFormatter.format(date).replace(".", "");
  }

  function formatISODate(value) {
    if (!value) {
      return "unbekannt";
    }

    const date = parseISODate(value);
    if (!date) {
      return value;
    }

    return fullDateFormatter.format(date);
  }

  function parseISODate(value) {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) {
      return null;
    }

    return new Date(year, month - 1, day);
  }

  function formatPercent(value) {
    if (!value) {
      return "0%";
    }

    return `${Math.round(value * 100)}%`;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function toISODate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isToday(value) {
    if (!value) {
      return false;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return false;
    }

    return toISODate(date) === toISODate(new Date());
  }

  function daysBetween(start, end) {
    return Math.max(0, Math.round((startOfDay(end) - startOfDay(start)) / DAY_MS));
  }

  function daysUntil(date) {
    if (!date || Number.isNaN(date.getTime())) {
      return null;
    }

    return Math.round((startOfDay(date) - startOfDay(new Date())) / DAY_MS);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  if (!window.__PREPLY_PLUS_UTILS__) {
    Object.defineProperty(window, "__PREPLY_PLUS_UTILS__", {
      value: Object.freeze({
        DAY_MS,
        dateFormatter,
        timeFormatter,
        parseMoney,
        parseNumber,
        parseLessonCount,
        parseDurationHours,
        parseLessonPrice,
        parseDate,
        money,
        rateMoney,
        rateOrNA,
        number,
        formatMonth,
        formatISODate,
        parseISODate,
        formatPercent,
        startOfDay,
        toISODate,
        isToday,
        daysBetween,
        daysUntil,
        escapeHtml
      }),
      configurable: false,
      enumerable: false,
      writable: false
    });
  }
})();
