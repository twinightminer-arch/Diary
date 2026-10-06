// SPDX-License-Identifier: AGPL-3.0-only
package app.diary.local;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.AtomicFile;
import android.util.Base64;
import android.webkit.*;
import android.view.View;
import org.json.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private WebView web;
  private File vault;
  private File media;
  private int documentRequest = -1;
  private byte[] exportData;
  private static final int IMPORT = 101, EXPORT = 102;
  private static final String ORIGIN = "https://appassets.androidplatform.net";

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    // Screenshots and app-switcher previews are intentionally allowed. Users own
    // their local data and may capture or share the screen like any other app.
    getWindow().setStatusBarColor(Color.rgb(248, 247, 244));
    getWindow().setNavigationBarColor(Color.rgb(248, 247, 244));
    vault = new File(getFilesDir(), "journals");
    if (!vault.isDirectory() && !vault.mkdirs()) throw new IllegalStateException("Cannot create journal directory");
    media = new File(getFilesDir(), "media");
    if (!media.isDirectory() && !media.mkdirs()) throw new IllegalStateException("Cannot create media directory");
    web = new WebView(this);
    web.setBackgroundColor(Color.rgb(248, 247, 244));
    web.setOnApplyWindowInsetsListener((view, insets) -> {
      view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
      return insets.consumeSystemWindowInsets();
    });
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setSupportMultipleWindows(false);
    web.addJavascriptInterface(new Bridge(), "NativeDiary");
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        String path = uri.getPath();
        if ("https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost()) &&
            path != null && path.matches("/(index\\.html|app\\.css|(?:app|i18n|security|storage)/[a-z-]+\\.js)")) {
          try {
            String mime = path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
            return new WebResourceResponse(mime, "UTF-8", getAssets().open(path.substring(1)));
          } catch (IOException ignored) { }
        }
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", null, new ByteArrayInputStream(new byte[0]));
      }
    });
    web.setWebChromeClient(new WebChromeClient());
    setContentView(web);
    web.loadUrl(ORIGIN + "/index.html");
  }

  private File mediaFile(String id) throws IOException {
    if (!id.matches("[A-Za-z0-9_-]{1,64}\\.[A-Za-z0-9]{1,8}")) throw new IOException("Invalid media id");
    File target = new File(media, id);
    if (!target.getCanonicalFile().getParentFile().equals(media.getCanonicalFile())) throw new IOException("Invalid media path");
    return target;
  }
  private static String extensionFor(String mime) throws IOException {
    switch (mime) {
      case "image/png": return "png";
      case "image/jpeg": return "jpg";
      case "image/gif": return "gif";
      case "image/webp": return "webp";
      case "image/svg+xml": return "svg";
      case "video/mp4": return "mp4";
      case "video/webm": return "webm";
      case "video/quicktime": return "mov";
      case "audio/mpeg": return "mp3";
      case "audio/mp4": return "m4a";
      case "audio/wav": case "audio/x-wav": return "wav";
      case "audio/webm": return "weba";
      case "audio/ogg": return "ogg";
      default: throw new IOException("Unsupported media type: " + mime);
    }
  }
  private static String mimeFor(String extension) {
    switch (extension) {
      case "png": return "image/png";
      case "jpg": return "image/jpeg";
      case "gif": return "image/gif";
      case "webp": return "image/webp";
      case "svg": return "image/svg+xml";
      case "mp4": return "video/mp4";
      case "webm": return "video/webm";
      case "mov": return "video/quicktime";
      case "mp3": return "audio/mpeg";
      case "m4a": return "audio/mp4";
      case "wav": return "audio/wav";
      case "weba": return "audio/webm";
      case "ogg": return "audio/ogg";
      default: return "application/octet-stream";
    }
  }
  private static String endpoint(JSONObject request) throws IOException {
    String base = request.optString("baseUrl", "").replaceAll("/+$", "");
    if (!base.startsWith("https://") || request.optString("apiKey", "").isEmpty())
      throw new IOException("Configure an AI provider in settings first");
    return base;
  }
  private static String diarySystem(String task) {
    String base = "You are a warm, thoughtful diary assistant. Write in the user's language, keep their voice, and never invent facts about them.";
    switch (task) {
      case "polish": return base + " Rewrite the draft so it reads better while keeping its meaning and tone. Return only the revised text.";
      case "title": return base + " Reply with one short title only, no quotes or punctuation.";
      case "continue": return base + " Continue the entry in the same voice, one to three sentences.";
      default: return base + " Draft or extend the diary entry from the notes provided. Return only the entry text.";
    }
  }
  private static String weatherText(int code) {
    if (code == 0) return "晴";
    if (code <= 2) return "多云";
    if (code == 3) return "阴";
    if (code <= 48) return "有雾";
    if (code <= 57) return "毛毛雨";
    if (code <= 67) return "下雨";
    if (code <= 77) return "下雪";
    if (code <= 82) return "阵雨";
    if (code <= 86) return "阵雪";
    if (code <= 99) return "雷阵雨";
    return "未知天气";
  }
  private static String encode(String value) throws IOException { return URLEncoder.encode(value, "UTF-8"); }
  /** Network access lives in the host; the page itself is locked down with connect-src 'none'. */
  private static String http(String method, String target, String body, String contentType, String bearer) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(target).openConnection();
    try {
      connection.setRequestMethod(method);
      connection.setConnectTimeout(15_000);
      connection.setReadTimeout(60_000);
      connection.setRequestProperty("Accept", "application/json");
      if (bearer != null && !bearer.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + bearer);
      if (body != null) {
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", contentType == null ? "application/json" : contentType);
        connection.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
      }
      int code = connection.getResponseCode();
      InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
      String text = stream == null ? "" : readText(stream);
      if (code >= 400) throw new IOException("HTTP " + code + " " + text);
      return text;
    } finally { connection.disconnect(); }
  }
  private File file(String id) throws IOException {
    if (!id.matches("[\\p{L}\\p{N}_-][\\p{L}\\p{N}_ .-]{0,99}") || id.endsWith(".") || id.endsWith(" ") ||
        id.matches("(?i)(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\\..*)?")) throw new IOException("Invalid entry id");
    File result = new File(vault, id + ".md");
    if (!result.getCanonicalFile().getParentFile().equals(vault.getCanonicalFile())) throw new IOException("Invalid path");
    return result;
  }
  private String read(File target) throws IOException {
    try (InputStream stream = new AtomicFile(target).openRead()) { return readText(stream); }
  }
  private static String readText(InputStream input) throws IOException {
    if (input == null) throw new IOException("Cannot read file");
    ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
    while ((count = input.read(buffer)) != -1) {
      if (output.size() + count > 10_000_000) throw new IOException("File exceeds 10 MB");
      output.write(buffer, 0, count);
    }
    return output.toString("UTF-8");
  }
  private void write(File target, String content, boolean create) throws IOException {
    if (content.getBytes(StandardCharsets.UTF_8).length > 10_000_000) throw new IOException("File exceeds 10 MB");
    if (create ? !target.createNewFile() : !target.isFile()) throw new IOException(create ? "Entry already exists" : "Entry not found");
    AtomicFile atomic = new AtomicFile(target); FileOutputStream output = null;
    try { output = atomic.startWrite(); output.write(content.getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(output); }
    catch (IOException error) { if (output != null) atomic.failWrite(output); if (create) atomic.delete(); throw error; }
  }
  private void reply(int id, Object value, Throwable error) {
    try {
      JSONObject response = new JSONObject(); response.put("ok", error == null);
      if (error == null) response.put("value", value == null ? JSONObject.NULL : value);
      else response.put("error", error.getMessage() == null ? error.toString() : error.getMessage());
      String script = "window.__diaryReply && window.__diaryReply(" + id + "," + response + ");";
      runOnUiThread(() -> { if (!isDestroyed()) web.evaluateJavascript(script, null); });
    } catch (JSONException ignored) { }
  }
  private final class Bridge {
    @JavascriptInterface public void request(int id, String json) {
      io.execute(() -> {
        try {
          JSONObject request = new JSONObject(json); String op = request.getString("op"); Object result = null;
          switch (op) {
            case "list": {
              String[] names = vault.list((dir, name) -> name.endsWith(".md") && new File(dir, name).isFile());
              if (names == null) throw new IOException("Cannot list entries");
              Arrays.sort(names); JSONArray ids = new JSONArray();
              for (String name : names) ids.put(name.substring(0, name.length() - 3));
              result = ids; break;
            }
            case "read": result = read(file(request.getString("id"))); break;
            case "create": case "write": write(file(request.getString("id")), request.getString("content"), op.equals("create")); break;
            case "delete": {
              File target = file(request.getString("id"));
              if (!target.isFile() || !target.delete()) throw new IOException("Cannot delete entry");
              break;
            }
            case "info": result = new JSONObject().put("platform", "Android").put("location", vault.getAbsolutePath()).put("version", "0.1.0"); break;
            case "import": case "export": {
              final byte[] payload = op.equals("export") ? read(file(request.getString("id"))).getBytes(StandardCharsets.UTF_8) : null;
              final String name = request.optString("id", "diary") + ".md";
              runOnUiThread(() -> {
                try {
                  if (documentRequest != -1) throw new IOException("File picker is already open");
                  documentRequest = id; exportData = payload;
                  Intent intent = new Intent(payload == null ? Intent.ACTION_OPEN_DOCUMENT : Intent.ACTION_CREATE_DOCUMENT);
                  intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType(payload == null ? "*/*" : "text/markdown");
                  if (payload != null) intent.putExtra(Intent.EXTRA_TITLE, name);
                  startActivityForResult(intent, payload == null ? IMPORT : EXPORT);
                } catch (Exception error) { documentRequest = -1; exportData = null; reply(id, null, error); }
              });
              return;
            }
            // Media: illustrations, backgrounds, music and avatars.
            case "media:import": {
              byte[] payload = Base64.decode(request.getString("data"), Base64.DEFAULT);
              if (payload.length == 0 || payload.length > 200 * 1024 * 1024) throw new IOException("Media payload out of range");
              String name = UUID.randomUUID() + "." + extensionFor(request.getString("mime"));
              try (OutputStream output = new FileOutputStream(new File(media, name))) { output.write(payload); }
              result = new JSONObject().put("id", name).put("name", request.optString("name", name))
                       .put("mime", request.getString("mime")).put("size", payload.length);
              break;
            }
            case "media:list": {
              String[] names = media.list();
              JSONArray items = new JSONArray();
              if (names != null) {
                Arrays.sort(names);
                for (String name : names) {
                  File target = new File(media, name);
                  if (!target.isFile() || !name.matches("[A-Za-z0-9_-]{1,64}\\.[A-Za-z0-9]{1,8}")) continue;
                  items.put(new JSONObject().put("id", name).put("name", name)
                            .put("mime", mimeFor(name.substring(name.lastIndexOf('.') + 1))).put("size", target.length()));
                }
              }
              result = items; break;
            }
            case "media:data": {
              File target = mediaFile(request.getString("id"));
              result = "data:" + mimeFor(target.getName().substring(target.getName().lastIndexOf('.') + 1))
                     + ";base64," + Base64.encodeToString(Files.readAllBytes(target.toPath()), Base64.NO_WRAP);
              break;
            }
            case "media:remove": {
              if (!mediaFile(request.getString("id")).delete()) throw new IOException("Cannot delete media");
              break;
            }
            // Date, weather and place lookups.
            case "web:date": {
              Date now = new Date();
              result = new JSONObject().put("iso", new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(now))
                       .put("label", new SimpleDateFormat("yyyy年M月d日 EEEE", Locale.SIMPLIFIED_CHINESE).format(now));
              break;
            }
            case "web:weather": {
              String url = "https://api.open-meteo.com/v1/forecast?latitude=" + request.getDouble("lat")
                         + "&longitude=" + request.getDouble("lon") + "&current=temperature_2m,relative_humidity_2m,weather_code";
              JSONObject current = new JSONObject(http("GET", url, null, null, null)).getJSONObject("current");
              result = new JSONObject().put("tempC", current.optDouble("temperature_2m"))
                       .put("humidity", current.opt("relative_humidity_2m"))
                       .put("description", weatherText(current.optInt("weather_code")));
              break;
            }
            case "web:geocode": {
              String url = "https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=" + request.getDouble("lat")
                         + "&longitude=" + request.getDouble("lon") + "&localityLanguage=zh";
              JSONObject place = new JSONObject(http("GET", url, null, null, null));
              result = new JSONObject().put("city", place.optString("city", "")).put("country", place.optString("countryName", ""));
              break;
            }
            case "web:search": {
              result = new JSONObject().put("note", "Add an AI provider in settings to enable web search on Android.");
              break;
            }
            // AI assistant: OpenAI-compatible chat and image endpoints.
            case "agent:compose": {
              JSONArray messages = new JSONArray();
              messages.put(new JSONObject().put("role", "system").put("content", diarySystem(request.optString("task", "compose"))));
              JSONArray incoming = request.optJSONArray("messages");
              if (incoming != null) for (int i = 0; i < incoming.length(); i++) messages.put(incoming.get(i));
              JSONObject payload = new JSONObject().put("model", request.optString("model", "")).put("messages", messages);
              JSONObject body = new JSONObject(http("POST", endpoint(request) + "/chat/completions", payload.toString(), "application/json", request.optString("apiKey", "")));
              result = body.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
              break;
            }
            case "agent:illustrate": {
              JSONObject payload = new JSONObject().put("model", "gpt-image-1")
                       .put("prompt", request.optString("prompt", "")).put("size", "1024x1024");
              JSONObject body = new JSONObject(http("POST", endpoint(request) + "/images/generations", payload.toString(), "application/json", request.optString("apiKey", "")));
              String image = body.getJSONArray("data").getJSONObject(0).optString("b64_json", "");
              if (image.isEmpty()) throw new IOException("Image provider returned no data");
              result = new JSONObject().put("id", "ai-" + System.currentTimeMillis() + ".png")
                       .put("mime", "image/png").put("dataUrl", "data:image/png;base64," + image);
              break;
            }
            // Google / Microsoft sign-in, finished in the browser.
            case "account:oauthBegin": {
              String provider = request.getString("provider");
              boolean microsoft = "microsoft".equals(provider);
              String path = microsoft ? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
                                      : "https://accounts.google.com/o/oauth2/v2/auth";
              result = new JSONObject().put("url", path + "?client_id=" + encode(request.getString("clientId"))
                + "&response_type=code&redirect_uri=" + encode(request.getString("redirectUri"))
                + "&scope=" + encode(microsoft ? "openid profile offline_access" : "openid email profile")
                + "&state=" + encode(request.getString("state"))
                + "&code_challenge=" + encode(request.getString("codeChallenge")) + "&code_challenge_method=S256");
              break;
            }
            case "account:oauthFinish": {
              boolean microsoft = "microsoft".equals(request.getString("provider"));
              String tokenUrl = microsoft ? "https://login.microsoftonline.com/common/oauth2/v2.0/token" : "https://oauth2.googleapis.com/token";
              String form = "grant_type=authorization_code&code=" + encode(request.getString("code"))
                + "&client_id=" + encode(request.optString("clientId", ""))
                + "&redirect_uri=" + encode(request.getString("redirectUri"))
                + "&code_verifier=" + encode(request.getString("codeVerifier"));
              JSONObject body = new JSONObject(http("POST", tokenUrl, form, "application/x-www-form-urlencoded", null));
              result = new JSONObject().put("ok", body.has("access_token"));
              break;
            }
            case "openExternal": {
              String url = request.optString("url", "");
              if (!url.startsWith("https://")) throw new IOException("Refusing to open a non-https URL");
              runOnUiThread(() -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
              break;
            }
            case "exit": runOnUiThread(() -> finish()); break;
            default: throw new IOException("Unsupported operation");
          }
          reply(id, result, null);
        } catch (Exception error) { reply(id, null, error); }
      });
    }
  }
  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != IMPORT && requestCode != EXPORT) return;
    final int id = documentRequest; final byte[] payload = exportData; documentRequest = -1; exportData = null;
    if (id == -1) return;
    if (resultCode != RESULT_OK || data == null || data.getData() == null) { reply(id, requestCode == EXPORT ? false : null, null); return; }
    Uri uri = data.getData();
    io.execute(() -> {
      try {
        if (requestCode == IMPORT) {
          try (InputStream input = getContentResolver().openInputStream(uri)) { reply(id, readText(input), null); }
        } else {
          try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
            if (output == null) throw new IOException("Cannot write file"); output.write(payload);
          }
          reply(id, true, null);
        }
      } catch (Exception error) { reply(id, null, error); }
    });
  }
  @Override public void onBackPressed() { web.evaluateJavascript("window.dispatchEvent(new Event('diary-back'))", null); }
  @Override protected void onDestroy() { io.shutdown(); web.removeJavascriptInterface("NativeDiary"); web.destroy(); super.onDestroy(); }
}
