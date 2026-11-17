import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val ver = Properties().apply { rootProject.file("version.properties").inputStream().use { load(it) } }
// The trip's address. Set the TABI_HOST repository variable on GitHub to build for another server.
val host: String = (System.getenv("TABI_HOST") ?: "").ifBlank { "trip.sanechristmas.party" }

android {
    namespace = "app.tabi.trip"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.tabi.trip"
        minSdk = 26
        targetSdk = 35
        versionCode = ver.getProperty("versionCode").toInt()
        versionName = ver.getProperty("versionName")
        manifestPlaceholders["host"] = host
        buildConfigField("String", "DEFAULT_HOST", "\"$host\"")
        // Lets Chrome show Tabi full screen (no address bar) once the site vouches for this app
        resValue("string", "asset_statements",
            "[{\\\"relation\\\": [\\\"delegate_permission/common.handle_all_urls\\\"], \\\"target\\\": {\\\"namespace\\\": \\\"web\\\", \\\"site\\\": \\\"https://$host\\\"}}]")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("TABI_KEYSTORE") ?: "missing.jks")
            storePassword = System.getenv("TABI_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("TABI_KEY_ALIAS") ?: "tabi"
            keyPassword = System.getenv("TABI_KEY_PASSWORD") ?: System.getenv("TABI_KEYSTORE_PASSWORD")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
    implementation("com.google.android.gms:play-services-location:21.3.0")
}
