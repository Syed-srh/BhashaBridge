
-- BhashaBridge Postgres / Supabase Master Schema

-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Uploaded Documents (Metadata & Ingestion Status)
CREATE TABLE IF NOT EXISTS uploaded_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename TEXT,
    file_type TEXT,
    url TEXT,
    page_count INT DEFAULT 1,
    detected_language VARCHAR(10) DEFAULT 'en',
    extraction_status VARCHAR(20) DEFAULT 'completed',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Scheme Knowledge Base (Curated Schemes & Embeddings)
CREATE TABLE IF NOT EXISTS scheme_knowledge_base (
    id VARCHAR(100) PRIMARY KEY,
    scheme_name TEXT NOT NULL,
    category VARCHAR(100),
    icon VARCHAR(10),
    official_url TEXT,
    summary TEXT,
    eligibility TEXT,
    benefits TEXT,
    documents_required TEXT,
    application_process TEXT,
    restrictions TEXT,
    target_profile TEXT,
    embedding vector(384),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. User Profiles (Optional User Demographics)
CREATE TABLE IF NOT EXISTS user_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_hash VARCHAR(64) UNIQUE,
    age INT,
    location VARCHAR(100),
    occupation VARCHAR(100),
    income NUMERIC(12, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Feedback Logs (Thumbs Up / Down & Stage Tagging)
CREATE TABLE IF NOT EXISTS feedback_logs (
    id SERIAL PRIMARY KEY,
    result_id TEXT NOT NULL,
    stage VARCHAR(50) DEFAULT 'simplification',
    rating VARCHAR(10) CHECK (rating IN ('up', 'down')),
    comment TEXT,
    language VARCHAR(10) DEFAULT 'en',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Previously Explained History (Matching UI Cards)
CREATE TABLE IF NOT EXISTS previously_explained (
    id SERIAL PRIMARY KEY,
    job_id VARCHAR(64) UNIQUE NOT NULL,
    source TEXT NOT NULL,
    language VARCHAR(10) DEFAULT 'en',
    scheme_name TEXT,
    simplified_text TEXT,
    eligibility TEXT,
    documents TEXT,
    benefit TEXT,
    how_to_apply TEXT,
    restrictions TEXT,
    citations JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
