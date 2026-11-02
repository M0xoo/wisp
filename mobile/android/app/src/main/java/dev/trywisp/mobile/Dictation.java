package dev.trywisp.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.util.ArrayList;
import java.util.function.BiConsumer;

/**
 * The composer's mic (web/js/features/dictate.js): Android's SpeechRecognizer, its partial results
 * streamed to the page as they come. wisp's page is served from the computer, where Capacitor's
 * bridge isn't injected, so MainActivity's `wispAndroid` starts and stops it and the answers go back
 * as `wisp-dictation` events: { state: listening | partial | final | end | error, text, error }.
 * Everything here runs on the main thread (SpeechRecognizer's rule).
 */
final class Dictation {
    private final android.content.Context context;
    private final BiConsumer<String, String[]> emit; // (state, [text, error])
    private SpeechRecognizer recognizer;
    private String heard = ""; // the latest partial: what the page shows if the final never comes

    Dictation(android.content.Context context, BiConsumer<String, String[]> emit) {
        this.context = context;
        this.emit = emit;
    }

    static boolean available(android.content.Context context) {
        return SpeechRecognizer.isRecognitionAvailable(context);
    }

    void start() {
        cancel();
        heard = "";
        recognizer = SpeechRecognizer.createSpeechRecognizer(context);
        recognizer.setRecognitionListener(new Listener());
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());
        // A prompt is often a few sentences with pauses to think: don't stop at the first breath.
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L);
        recognizer.startListening(intent);
    }

    // Tap again: stop listening; the final result still comes, then `end`.
    void stop() {
        if (recognizer != null) recognizer.stopListening();
    }

    boolean active() {
        return recognizer != null;
    }

    void cancel() {
        if (recognizer == null) return;
        recognizer.cancel();
        recognizer.destroy();
        recognizer = null;
    }

    private void done(String state, String text, String error) {
        emit.accept(state, new String[] {text, error});
        cancel();
        emit.accept("end", new String[] {"", ""});
    }

    private static String first(Bundle results) {
        ArrayList<String> list = results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return list == null || list.isEmpty() || list.get(0) == null ? "" : list.get(0);
    }

    private final class Listener implements RecognitionListener {
        @Override public void onReadyForSpeech(Bundle params) { emit.accept("listening", new String[] {"", ""}); }
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int eventType, Bundle params) {}

        @Override
        public void onPartialResults(Bundle partial) {
            String text = first(partial);
            if (text.isEmpty()) return;
            heard = text;
            emit.accept("partial", new String[] {text, ""});
        }

        @Override
        public void onResults(Bundle results) {
            String text = first(results);
            done("final", text.isEmpty() ? heard : text, "");
        }

        @Override
        public void onError(int error) {
            // Silence or nothing understood after some words: keep what was heard, it's not a failure.
            if ((error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) && !heard.isEmpty()) {
                done("final", heard, "");
                return;
            }
            done("error", heard, reason(error));
        }
    }

    // What the page says (web/js/features/dictate.js maps these to words).
    private static String reason(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "denied";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "silence";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "network";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "busy";
            case SpeechRecognizer.ERROR_AUDIO: return "audio";
            default: return "failed";
        }
    }
}
