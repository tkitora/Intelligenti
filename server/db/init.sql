SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS shelves (
    id VARCHAR(32) NOT NULL,
    name VARCHAR(100) NOT NULL,
    zone VARCHAR(100) NULL,
    marker_id VARCHAR(64) NULL,
    position_x DECIMAL(8,3) NOT NULL DEFAULT 0,
    position_y DECIMAL(8,3) NOT NULL DEFAULT 0,
    position_z DECIMAL(8,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_shelves_marker_id (marker_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(32) NOT NULL,
    name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    price_yen INT UNSIGNED NOT NULL,
    stock INT UNSIGNED NOT NULL DEFAULT 0,
    shelf_id VARCHAR(32) NULL,
    image_url VARCHAR(500) NULL,
    shelf_offset_x DECIMAL(8,3) NOT NULL DEFAULT 0,
    shelf_offset_y DECIMAL(8,3) NOT NULL DEFAULT 0,
    shelf_offset_z DECIMAL(8,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_products_name (name),
    KEY idx_products_shelf_id (shelf_id),
    CONSTRAINT fk_products_shelf
        FOREIGN KEY (shelf_id) REFERENCES shelves (id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scan_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    reader_id VARCHAR(32) NOT NULL,
    product_id VARCHAR(32) NOT NULL,
    tag_uid VARCHAR(32) NULL,
    wifi_rssi INT NULL,
    scanned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_scan_events_product_id (product_id),
    KEY idx_scan_events_scanned_at (scanned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS goggle_targets (
    goggle_id VARCHAR(32) NOT NULL,
    product_id VARCHAR(32) NOT NULL,
    version BIGINT UNSIGNED NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (goggle_id),
    KEY idx_goggle_targets_product_id (product_id),
    CONSTRAINT fk_goggle_targets_product
        FOREIGN KEY (product_id) REFERENCES products (id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- This installation intentionally owns one store and one top-down map.
-- The editor saves the whole layout atomically so operators never manage
-- coordinates, graph nodes, floors, or store identifiers themselves.
CREATE TABLE IF NOT EXISTS store_map (
    id TINYINT UNSIGNED NOT NULL DEFAULT 1,
    name VARCHAR(100) NOT NULL DEFAULT '店舗マップ',
    width_m DECIMAL(8,2) NOT NULL DEFAULT 24.00,
    depth_m DECIMAL(8,2) NOT NULL DEFAULT 16.00,
    layout_json JSON NOT NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_store_map_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shelves (id, name, zone, marker_id)
VALUES ('SHELF-A01', '飲料棚 A-01', '飲料売場', 'MARKER-A01')
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    zone = VALUES(zone),
    marker_id = VALUES(marker_id);

INSERT INTO products (
    id, name, description, price_yen, stock, shelf_id,
    shelf_offset_x, shelf_offset_y, shelf_offset_z
)
VALUES (
    'PRD-00000001', 'サンプル緑茶',
    'Intelligentiの動作確認用商品です。', 128, 24, 'SHELF-A01',
    0.080, 0.060, 0.020
)
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    description = VALUES(description),
    price_yen = VALUES(price_yen),
    stock = VALUES(stock),
    shelf_id = VALUES(shelf_id),
    shelf_offset_x = VALUES(shelf_offset_x),
    shelf_offset_y = VALUES(shelf_offset_y),
    shelf_offset_z = VALUES(shelf_offset_z);
