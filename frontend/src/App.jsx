import { useState } from "react";
import UploadZone from "./components/UploadZone";
import PageClassification from "./components/PageClassification";
import ExtractionReview from "./components/ExtractionReview";

const STEPS = ["Upload", "Classify Pages", "Review & Save"];

export default function App() {
  const [step, setStep] = useState(0);
  const [uploadResult, setUploadResult] = useState(null);
  const [extractionResult, setExtractionResult] = useState(null);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">Quick Bid Scanner</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload construction plans, classify pages, extract bid data
        </p>
      </header>

      {/* Step indicator */}
      <div className="max-w-5xl mx-auto px-6 pt-6">
        <nav className="flex items-center gap-2 mb-8">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
                  i === step
                    ? "bg-blue-600 text-white"
                    : i < step
                      ? "bg-green-500 text-white"
                      : "bg-gray-200 text-gray-500"
                }`}
              >
                {i < step ? "✓" : i + 1}
              </div>
              <span
                className={`text-sm ${i === step ? "font-semibold text-gray-900" : "text-gray-500"}`}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <div className="w-12 h-px bg-gray-300 mx-1" />
              )}
            </div>
          ))}
        </nav>
      </div>

      <main className="max-w-5xl mx-auto px-6 pb-12">
        {step === 0 && (
          <UploadZone
            onComplete={(result) => {
              setUploadResult(result);
              setStep(1);
            }}
          />
        )}
        {step === 1 && uploadResult && (
          <PageClassification
            data={uploadResult}
            onBack={() => setStep(0)}
            onComplete={(result) => {
              setExtractionResult(result);
              setStep(2);
            }}
          />
        )}
        {step === 2 && extractionResult && (
          <ExtractionReview
            data={extractionResult}
            onBack={() => setStep(1)}
            onStartOver={() => {
              setStep(0);
              setUploadResult(null);
              setExtractionResult(null);
            }}
          />
        )}
      </main>
    </div>
  );
}
