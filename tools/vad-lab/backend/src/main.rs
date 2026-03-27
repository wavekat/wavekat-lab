mod audio_source;
mod pipeline;
mod session;
mod spectrum;
mod ws;

use axum::{
    extract::{Multipart, WebSocketUpgrade},
    http::StatusCode,
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use clap::Parser;
use serde_json::json;
use tower_http::cors::CorsLayer;

#[derive(Parser)]
#[command(name = "vad-lab", about = "VAD experimentation tool")]
struct Args {
    /// Port to listen on.
    #[arg(short, long, default_value = "3000")]
    port: u16,

    /// Host to bind to.
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "vad_lab=info".into()),
        )
        .init();

    let args = Args::parse();

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/upload", post(upload_handler))
        .route("/", get(index_handler))
        .layer(CorsLayer::permissive());

    let addr = format!("{}:{}", args.host, args.port);
    tracing::info!("vad-lab server listening on http://{addr}");
    tracing::info!("open http://{addr} in your browser");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            tracing::error!(
                "port {} is already in use — kill the existing process with: lsof -ti:{} | xargs kill",
                args.port, args.port
            );
        } else {
            tracing::error!("failed to bind to {addr}: {e}");
        }
        std::process::exit(1);
    });
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(ws::handle_ws)
}

async fn upload_handler(mut multipart: Multipart) -> Result<Json<serde_json::Value>, StatusCode> {
    let field = multipart
        .next_field()
        .await
        .map_err(|e| {
            tracing::error!("failed to read multipart: {e}");
            StatusCode::BAD_REQUEST
        })?
        .ok_or(StatusCode::BAD_REQUEST)?;

    let file_name = field.file_name().unwrap_or("upload.wav").to_string();

    // Only accept .wav files
    if !file_name.to_lowercase().ends_with(".wav") {
        return Err(StatusCode::BAD_REQUEST);
    }

    let data = field.bytes().await.map_err(|e| {
        tracing::error!("failed to read upload: {e}");
        StatusCode::BAD_REQUEST
    })?;

    // Save to temp directory with a unique name
    let temp_dir = std::env::temp_dir().join("vad-lab-uploads");
    std::fs::create_dir_all(&temp_dir).map_err(|e| {
        tracing::error!("failed to create temp dir: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let dest = temp_dir.join(format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        file_name
    ));

    std::fs::write(&dest, &data).map_err(|e| {
        tracing::error!("failed to write upload: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let path_str = dest.to_string_lossy().to_string();
    let channels = audio_source::probe_wav_channels(&dest).unwrap_or(1);
    tracing::info!(path = %path_str, size = data.len(), channels, "file uploaded");

    Ok(Json(json!({ "path": path_str, "channels": channels })))
}

async fn index_handler() -> Html<&'static str> {
    Html(
        r#"<!DOCTYPE html>
<html>
<head><title>vad-lab</title></head>
<body>
    <h1>vad-lab</h1>
    <p>Frontend not yet built. Run <code>npm run dev</code> in <code>tools/vad-lab/frontend/</code> for the dev server.</p>
    <p>WebSocket endpoint: <code>ws://localhost:3000/ws</code></p>
</body>
</html>"#,
    )
}
