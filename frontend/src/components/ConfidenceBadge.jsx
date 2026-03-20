const STYLES = {
  extracted: "bg-green-100 text-green-800 border-green-300",
  inferred: "bg-yellow-100 text-yellow-800 border-yellow-300",
  not_found: "bg-red-100 text-red-800 border-red-300",
};

const LABELS = {
  extracted: "Extracted",
  inferred: "Inferred",
  not_found: "Not Found",
};

export default function ConfidenceBadge({ confidence }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs font-medium rounded border ${STYLES[confidence] || STYLES.not_found}`}
    >
      {LABELS[confidence] || confidence}
    </span>
  );
}
